import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ReservationRepository } from '@app/shop/inventory/reservation.repository';
import { OrderRepository } from '../../repositories/order.repository';
@Injectable()
export class ExpireReservations {
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
          order?.status !== 'PENDING' ||
          !(await this.reservations.hasExpired(manager, id))
        )
          return 0;
        const count = await this.reservations.release(manager, id);
        await this.orders.update(manager, id, { status: 'CANCELLED' });
        return count;
      });
      if (released)
        this.metrics.reservations.inc({ result: 'expired' }, released);
    }
  }
}
