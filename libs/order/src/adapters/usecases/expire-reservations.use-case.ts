import { OrderStatus } from '@app/contracts';
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ReservationRepository } from '@app/shop/inventory/reservation.repository';
import { OrderRepository } from '@app/order/repositories/order.repository';

/**
 * 
 * TODO create a new app for handling scheduled tasks
 *  and this new app should create events that should be consumed by process-order-event.use-case 
 * the events should have the following structure: { kind: string, data: any, meta: any}
 */ 
@Injectable()
export class ExpireReservationsUseCase {
  private running = false;
  constructor(
    private readonly database: DataSource,
    private readonly reservations: ReservationRepository,
    private readonly orders: OrderRepository,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
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
      if (released)
        this.metrics.reservations.inc({ result: 'expired' }, released);
    }
  }
}
