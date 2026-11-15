import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@app/order/domain/shared/types/order.type';
import { DataSource } from 'typeorm';
import { Metrics } from '@app/platform/observability/metrics';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { EventHandler } from '@app/order/adapters/handlers/event.handler';
import {
  ORDER_RESERVATION_EXPIRED,
  ReservationExpiredEvent,
} from '@app/order/messaging/order-events';

@Injectable()
export class ReservationExpiredHandler implements EventHandler<ReservationExpiredEvent> {
  readonly kind = ORDER_RESERVATION_EXPIRED;

  constructor(
    private readonly database: DataSource,
    private readonly orders: OrderRepository,
    private readonly reservations: ReservationRepository,
    private readonly metrics: Metrics,
  ) {}

  async handle(event: ReservationExpiredEvent): Promise<void> {
    const orderId = event.data.order_id;
    const released = await this.database.transaction(async (manager) => {
      const order = await this.orders.lock(manager, orderId);
      if (
        order?.status !== OrderStatus.Pending ||
        !(await this.reservations.hasExpired(manager, orderId))
      )
        return 0;
      const count = await this.reservations.release(manager, orderId);
      await this.orders.update(manager, orderId, {
        status: OrderStatus.Cancelled,
      });
      return count;
    });

    if (released)
      this.metrics.reservations.inc({ result: 'expired' }, released);
  }
}
