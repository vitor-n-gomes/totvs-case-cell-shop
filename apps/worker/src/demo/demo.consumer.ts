import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaConnection } from '@app/platform/messaging/kafka-connection';
import { HealthService } from '@app/platform/health/health.service';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ReceiveMessage } from '@app/demo/use-cases/receive-message';
import { MessageCreated, messageCreatedSchema } from '@app/contracts';

@Injectable()
export class DemoConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly consumer;

  constructor(
    kafka: KafkaConnection,
    private readonly config: ConfigService,
    private readonly receive: ReceiveMessage,
    private readonly logger: AppLogger,
    private readonly health: HealthService,
  ) {
    this.consumer = kafka.kafka.consumer({
      groupId: config.getOrThrow<string>('KAFKA_GROUP_ID'),
      allowAutoTopicCreation: false,
    });
    this.health.consumerReady = false;
    this.consumer.on(this.consumer.events.GROUP_JOIN, () => {
      this.health.consumerReady = true;
    });
    for (const event of [
      this.consumer.events.CRASH,
      this.consumer.events.DISCONNECT,
      this.consumer.events.STOP,
    ]) {
      this.consumer.on(event, () => {
        this.health.consumerReady = false;
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.config.getOrThrow<string>('KAFKA_TOPIC'),
      fromBeginning: true,
    });
    await this.consumer.run({
      eachMessage: async ({ message, topic, partition }) => {
        let event: MessageCreated | undefined;
        try {
          event = messageCreatedSchema.parse(
            JSON.parse(message.value?.toString() ?? 'null'),
          );
          await this.receive.execute(event);
          this.logger.info('demo.message.received', {
            eventId: event.eventId,
            correlationId: event.correlationId,
          });
        } catch (error) {
          this.logger.info('demo.message.processing.failed', {
            topic,
            partition,
            offset: message.offset,
            eventId: event?.eventId,
            correlationId: event?.correlationId,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          });
          // KafkaJS must see failures: returning here would allow committing a failed event.
          // eslint-disable-next-line preserve-caught-error -- KafkaJS logs errors; causes may expose payloads or credentials.
          throw new Error('Message processing failed');
        }
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.health.consumerReady = false;
    await this.consumer.stop();
    await this.consumer.disconnect();
  }
}
