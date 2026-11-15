import { OrderStatus } from '@app/order/domain/shared/types/order.type';
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { EventBus } from '@app/order/adapters/handlers/event.bus';
import {
  ORDER_RESERVATION_EXPIRED,
  ReservationExpiredEvent,
} from '@app/order/messaging/order-events';
import { createEventMeta } from '@app/order/messaging/order-event';
import {
  executionContext,
  newTraceContext,
} from '@app/platform/observability/context';

@Injectable()
export class ExpireReservationsUseCase {
  private running = false;
  constructor(
    private readonly database: DataSource,
    private readonly reservations: ReservationRepository,
    private readonly orders: OrderRepository,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly eventBus: EventBus,
  ) {}

  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.execute();
    } catch {
      this.logger.error('reservations.cleanup.failed');
    } finally {
      this.running = false;
    }
  }

  async execute(): Promise<void> {
    for (const id of await this.reservations.expiredOrderIds()) {
      const released = await this.database.transaction(async (manager) => {
        const order = await this.orders.lock(manager, id);
        if (
          order?.status !== OrderStatus.Pending ||
          !(await this.reservations.hasExpired(manager, id))
        )
          return 0;
        const count = await this.reservations.release(manager, id);
        await this.orders.update(manager, id, {
          status: OrderStatus.Cancelled,
        });
        return count;
      });
      if (released) {
        this.metrics.reservations.inc({ result: 'expired' }, released);

        const context = {
          ...newTraceContext(randomUUID()),
          order_id: id,
        };
        await executionContext.run(context, () => {
          const event: ReservationExpiredEvent = {
            kind: ORDER_RESERVATION_EXPIRED,
            data: { order_id: id },
            meta: createEventMeta(context.correlation_id),
          };
          return this.eventBus.dispatch(event);
        });
      }
    }
  }
}
