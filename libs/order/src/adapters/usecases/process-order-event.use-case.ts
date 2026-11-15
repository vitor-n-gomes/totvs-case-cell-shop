import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  parseOrderEvent,
  OrderEvent,
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
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
    const event = parseOrderEvent(payload);
    if (!event) {
      await this.sendToDlq(
        payload,
        source,
        'Invalid event payload',
        'invalid_dlq',
      );
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
        this.logger.info('order.event.received', {
          event_id: event.meta?.event_id,
          kind: event.kind,
        });

        try {
          await this.dispatchByKind(event);
        } catch (error) {
          await this.sendToDlq(
            event,
            source,
            error instanceof Error ? error.message : 'Unknown error',
            'dlq',
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
    }
  }

  private async sendToDlq(
    payload: unknown,
    source: EventSource,
    reason: string,
    metricResult: 'dlq' | 'invalid_dlq',
    orderId?: string,
  ): Promise<void> {
    const correlationId =
      executionContext.getStore()?.correlation_id ?? randomUUID();

    await this.messaging.publish(
      `${this.config.getOrThrow<string>('CHECKOUT_TOPIC')}.dlq`,
      orderId ?? `${source.topic}:${source.partition}:${source.offset}`,
      this.toDlqPayload(payload),
      {
        'x-correlation-id': correlationId,
        'x-dlq-reason': reason,
        'x-source-topic': source.topic,
        'x-source-partition': String(source.partition),
        'x-source-offset': source.offset,
      },
    );

    this.metrics.processing.inc({ result: metricResult });
  }

  private toDlqPayload(payload: unknown): Record<string, unknown> {
    if (
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload)
    ) {
      return payload as Record<string, unknown>;
    }

    return { raw_payload: payload ?? null };
  }
}
