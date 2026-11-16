import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  OrderEvent,
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
} from '@app/order/messaging/order-events';
import { AppLogger } from '@app/platform/logging/app-logger';
import { executionContext } from '@app/platform/observability/context';
import { CheckoutInitiatedHandler } from './event-handlers/checkout-initiated.handler';
import { ReservationExpiredHandler } from './event-handlers/reservation-expired.handler';

@Injectable()
export class ProcessOrderEventUseCase {
  constructor(
    private readonly checkoutInitiatedHandler: CheckoutInitiatedHandler,
    private readonly reservationExpiredHandler: ReservationExpiredHandler,
    private readonly appLogger: AppLogger,
  ) {}

  async handle(event: OrderEvent): Promise<void> {
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
        this.appLogger.info('order.event.received', {
          event_id: event.meta?.event_id,
          kind: event.kind,
        });

        try {

          await this.dispatchByKind(event);

        } catch (error) {

          this.appLogger.error('order.event.dispatch.failed', {
            error_type: error instanceof Error ? error.name : 'UnknownError',
          });

          throw error;

        }
      },
    );
  }

  private async dispatchByKind(event: OrderEvent): Promise<void> {
    switch (event.kind) {

      case ORDER_CHECKOUT_INITIATED:
        await this.checkoutInitiatedHandler.execute(event);
        break;

      case ORDER_RESERVATION_EXPIRED:
        await this.reservationExpiredHandler.handle(event);
        break;

    }
  }
}
