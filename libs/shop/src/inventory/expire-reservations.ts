import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ReservationRepository } from './reservation.repository';

@Injectable()
export class ExpireReservations {
  private running = false;
  constructor(
    private readonly database: DataSource,
    private readonly reservations: ReservationRepository,
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
    const candidates: { order_id: string }[] = await this.database.query(
      "SELECT order_id FROM stock_reservation WHERE status='ACTIVE' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 1000",
    );
    for (const id of [
      ...new Set(candidates.map((entry) => entry.order_id)),
    ].sort()) {
      const released = await this.database.transaction(async (manager) => {
        const [order]: { status: string }[] = await manager.query(
          'SELECT status FROM "order" WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (order?.status !== 'PENDING') return 0;
        const expired: { id: string }[] = await manager.query(
          "SELECT id FROM stock_reservation WHERE order_id=$1 AND status='ACTIVE' AND expires_at<=clock_timestamp() LIMIT 1",
          [id],
        );
        if (!expired.length) return 0;
        const count = await this.reservations.release(manager, id);
        await manager.query(
          'UPDATE "order" SET status=\'CANCELLED\' WHERE id=$1',
          [id],
        );
        return count;
      });
      if (released)
        this.metrics.reservations.inc({ result: 'expired' }, released);
    }
  }
}
