import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  parseOrderEvent,
  OrderEvent,
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  ORDER_CHECKOUT_FAILED,
  ORDER_EVENT_INVALID,
  InvalidOrderEvent,
} from '@app/order/messaging/order-events';
import { AppLogger } from '@app/platform/logging/app-logger';
import { executionContext } from '@app/platform/observability/context';
import { Metrics } from '@app/platform/observability/metrics';
import { createEventMeta } from '@app/order/messaging/order-event';
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
    const event = parseOrderEvent(payload);
    if (!event) {
      await this.deadLetter(source, 'Invalid event');
      return;
    }

    const orderId = event.data.order_id;
    const correlationId = event.meta?.correlation_id ?? randomUUID();

    await executionContext.run(
      {
        correlation_id: correlationId,
        order_id: orderId,
        trace_id: event.meta?.trace_id ?? randomBytes(16).toString('hex'),
        span_id: randomBytes(8).toString('hex'),
        parent_span_id: event.meta?.parent_span_id,
      },
      async () => {
        this.logger.info('checkout.event.received', {
          event_id: event.meta?.event_id,
          kind: event.kind,
        });

        try {
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

  private async dispatchByKind(event: OrderEvent): Promise<void> {
    switch (event.kind) {
      case ORDER_CHECKOUT_INITIATED:
        await this.checkoutInitiated.execute(event);
        break;

      case ORDER_RESERVATION_EXPIRED:
        await this.reservationExpired.handle(event);
        break;

      case ORDER_CHECKOUT_FAILED:
        this.logger.warn('checkout.failed.event.received', {
          order_id: event.data.order_id,
          failure: event.data.failure,
          failed_step: event.data.failed_step,
        });
        break;

      case ORDER_EVENT_INVALID:
        this.logger.error('invalid.event.received', {
          source_topic: event.data.source_topic,
          reason: event.data.reason,
          order_id: event.data.order_id,
        });
        break;
    }
  }

  private async deadLetter(
    source: EventSource,
    reason: string,
    orderId?: string,
  ): Promise<void> {
    const correlationId =
      executionContext.getStore()?.correlation_id ?? randomUUID();
    const event: InvalidOrderEvent = {
      kind: ORDER_EVENT_INVALID,
      data: {
        source_topic: source.topic,
        partition: source.partition,
        offset: source.offset,
        reason,
        order_id: orderId,
      },
      meta: createEventMeta(correlationId),
    };
    await this.messaging.publish(
      `${this.config.getOrThrow<string>('CHECKOUT_TOPIC')}.dlq`,
      orderId ?? `${source.topic}:${source.partition}:${source.offset}`,
      event,
      { 'x-correlation-id': correlationId },
    );
    this.metrics.processing.inc({ result: 'invalid_dlq' });
  }
}
