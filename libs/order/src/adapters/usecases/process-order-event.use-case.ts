import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { checkoutEventSchema } from '@app/contracts';
import { AppLogger } from '@app/platform/logging/app-logger';
import { executionContext } from '@app/platform/observability/context';
import { Metrics } from '@app/platform/observability/metrics';
import { ActiveOrderUseCase } from '../../activation/active-order.use-case';
import { PermanentActivationError } from '../../activation/guards/activation-errors';
import { OrderMessaging } from '../order.messaging';
export interface EventSource {
  topic: string;
  partition: number;
  offset: string;
}

/**
  * 
 * process-order-event.use-case  should receive and handle events from the scheduled and http app
 * the events should have the following structure: { kind: string, data: any, meta: any}
 * 
 */ 

@Injectable()
export class ProcessOrderEventUseCase {
  constructor(
    private readonly activation: ActiveOrderUseCase,
    private readonly messaging: OrderMessaging,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}
  async handle(payload: unknown, source: EventSource): Promise<void> {
    const result = checkoutEventSchema.safeParse(payload);
    if (!result.success) {
      await this.deadLetter(source, 'Invalid event');
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
            await this.deadLetter(source, error.message, event.order_id);
            return;
          }
          throw error;
        }
      },
    );
  }
  private async deadLetter(
    source: EventSource,
    reason: string,
    orderId?: string,
  ): Promise<void> {
    await this.messaging.publish(
      `${this.config.getOrThrow<string>('CHECKOUT_TOPIC')}.dlq`,
      orderId ?? `${source.topic}:${source.partition}:${source.offset}`,
      {
        source_topic: source.topic,
        partition: source.partition,
        offset: source.offset,
        reason,
        order_id: orderId,
      },
    );
    this.metrics.processing.inc({ result: 'invalid_dlq' });
  }
}
