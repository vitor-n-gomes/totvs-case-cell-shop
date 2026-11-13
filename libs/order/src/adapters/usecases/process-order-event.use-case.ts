import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import {
  normalizeOrderEvent,
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  ORDER_CHECKOUT_FAILED,
  ORDER_EVENT_INVALID,
} from '@app/order/messaging/order-events';
import { AppLogger } from '@app/platform/logging/app-logger';
import { executionContext } from '@app/platform/observability/context';
import { Metrics } from '@app/platform/observability/metrics';
import { OrderMessaging } from '../order.messaging';
import { CheckoutInitiatedHandler } from './event-handlers/checkout-initiated.handler';
import { ReservationExpiredHandler } from './event-handlers/reservation-expired.handler';

export interface EventSource {
  topic: string;
  partition: number;
  offset: string;
}

@Injectable()
export class ProcessOrderEventUseCase {
  constructor(
    private readonly checkoutInitiated: CheckoutInitiatedHandler,
    private readonly reservationExpired: ReservationExpiredHandler,
    private readonly messaging: OrderMessaging,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async handle(payload: unknown, source: EventSource): Promise<void> {
    const event = normalizeOrderEvent(payload);
    if (!event) {
      await this.deadLetter(source, 'Invalid event');
      return;
    }

    // Extract order_id from nested structure safely
    const orderId = (event.data as any).data?.order_id;
    if (!orderId) {
      await this.deadLetter(source, 'Missing order_id in event');
      return;
    }

    await executionContext.run(
      {
        correlation_id: event.meta.correlation_id,
        order_id: orderId,
        trace_id: event.meta.trace_id,
        span_id: randomBytes(8).toString('hex'),
      },
      async () => {
        this.logger.info('checkout.event.received', {
          event_id: event.meta.event_id,
          parent_span_id: (event.meta as any).parent_span_id,
          kind: (event.data as any).kind,
        });
        try {
          // Dispatch to appropriate handler based on event kind
          await this.dispatchByKind(event);
        } catch (error) {
          await this.deadLetter(
            source,
            error instanceof Error ? error.message : 'Unknown error',
            orderId,
          );
        }
      },
    );
  }

  /**
   * Dispatch event to appropriate handler based on kind
   * This centralizes event routing logic in one place
   */
  private async dispatchByKind(event: any): Promise<void> {
    const kind = (event.data as any).kind;

    switch (kind) {
      case ORDER_CHECKOUT_INITIATED:
        await this.checkoutInitiated.execute(event);
        break;

      case ORDER_RESERVATION_EXPIRED:
        await this.reservationExpired.handle(event);
        break;

      case ORDER_CHECKOUT_FAILED:
        this.logger.warn('checkout.failed.event.received', {
          order_id: (event.data as any).data?.order_id,
          failure: (event.data as any).data?.failure,
        });
        // TODO: Implement CheckoutFailedHandler for retry logic
        break;

      case ORDER_EVENT_INVALID:
        this.logger.error('invalid.event.received', {
          source_topic: (event.data as any).data?.source_topic,
          reason: (event.data as any).data?.reason,
        });
        // DLQ already handled by Kafka, just log
        break;

      default:
        this.logger.warn('unknown.event.kind.received', {
          kind,
          order_id: (event.data as any).data?.order_id,
        });
        throw new Error(`Unknown event kind: ${kind}`);
    }
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
