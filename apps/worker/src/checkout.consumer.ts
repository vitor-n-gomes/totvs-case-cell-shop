import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { checkoutEventSchema } from '@app/contracts';
import { KafkaConnection } from '@app/platform/messaging/kafka-connection';
import { HealthService } from '@app/platform/health/health.service';
import { AppLogger } from '@app/platform/logging/app-logger';
import { executionContext } from '@app/platform/observability/context';
import { Metrics } from '@app/platform/observability/metrics';
import { ActiveOrderUseCase } from '@app/shop/activation/active-order.use-case';
import { PermanentActivationError } from '@app/shop/activation/guards/activation-errors';

@Injectable()
export class CheckoutConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly consumer;
  private stopping = false;
  constructor(
    private readonly kafka: KafkaConnection,
    private readonly config: ConfigService,
    private readonly activation: ActiveOrderUseCase,
    private readonly health: HealthService,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {
    this.consumer = kafka.kafka.consumer({
      groupId: `${config.getOrThrow<string>('KAFKA_GROUP_ID')}-checkout`,
      allowAutoTopicCreation: false,
    });
    this.health.checkoutConsumerReady = false;
    this.consumer.on(this.consumer.events.GROUP_JOIN, () => {
      this.health.checkoutConsumerReady = true;
    });
    for (const name of [
      this.consumer.events.CRASH,
      this.consumer.events.DISCONNECT,
      this.consumer.events.STOP,
    ])
      this.consumer.on(name, () => {
        this.health.checkoutConsumerReady = false;
      });
  }
  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.config.getOrThrow<string>('CHECKOUT_TOPIC'),
      fromBeginning: true,
    });
    await this.consumer.run({
      eachMessage: async ({ message, topic, partition, heartbeat }) => {
        const heartbeatTimer = setInterval(() => {
          void heartbeat().catch(() => undefined);
        }, 1000);
        try {
          while (!this.stopping) {
            try {
              await this.handle(
                message.value?.toString() ?? '',
                topic,
                partition,
                message.offset,
              );
              return;
            } catch {
              this.logger.error('checkout.consumer.waiting_for_recovery');
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
          throw new Error('Consumer stopped before message completed');
        } finally {
          clearInterval(heartbeatTimer);
        }
      },
    });
  }
  async handle(
    raw: string,
    topic: string,
    partition: number,
    offset: string,
  ): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = null;
    }
    const result = checkoutEventSchema.safeParse(decoded);
    if (!result.success) {
      await this.deadLetter(topic, partition, offset, 'Invalid event');
      return;
    }
    const event = result.data;
    await executionContext.run(
      {
        correlation_id: event.correlation_id,
        order_id: event.order_id,
        trace_id: event.trace_id,
        span_id: randomBytes(8).toString('hex'),
      },
      async () => {
        this.logger.info('checkout.event.received', {
          event_id: event.event_id,
          parent_span_id: event.parent_span_id,
        });
        try {
          await this.activation.execute(event);
        } catch (error) {
          if (error instanceof PermanentActivationError) {
            await this.deadLetter(
              topic,
              partition,
              offset,
              error.message,
              event.order_id,
            );
            return;
          }
          this.logger.error('checkout.consumer.failed');
          // Storage failures must prevent offset advancement; retries resume after recovery.
          throw new Error('Checkout processing failed', { cause: error });
        }
      },
    );
  }
  private async deadLetter(
    topic: string,
    partition: number,
    offset: string,
    reason: string,
    orderId?: string,
  ): Promise<void> {
    await this.kafka.ensureConnected();
    await this.kafka.producer.send({
      topic: `${this.config.getOrThrow<string>('CHECKOUT_TOPIC')}.dlq`,
      acks: -1,
      messages: [
        {
          key: orderId ?? `${topic}:${partition}:${offset}`,
          value: JSON.stringify({
            source_topic: topic,
            partition,
            offset,
            reason,
            order_id: orderId,
          }),
        },
      ],
    });
    this.metrics.processing.inc({ result: 'invalid_dlq' });
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.health.checkoutConsumerReady = false;
    await this.consumer.stop();
    await this.consumer.disconnect();
  }
}
