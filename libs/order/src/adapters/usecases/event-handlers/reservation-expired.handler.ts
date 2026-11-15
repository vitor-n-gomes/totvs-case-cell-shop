import { Injectable } from '@nestjs/common';
import { EntityManager, QueryRunner } from 'typeorm';
import {
  EXPIRABLE_ORDER_STATUSES,
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { CATALOG_KEY } from '@app/products/adapters/usecases/get-products.use-case';
import { EventHandler } from '@app/order/adapters/handlers/event.handler';
import {
  ORDER_RESERVATION_EXPIRED,
  ReservationExpiredEvent,
} from '@app/order/messaging/order-events';

type ExpireOutcome =
  | { result: 'expired'; released: number }
  | { result: 'already_processed' | 'completed' | 'not_found' | 'not_expired' };

@Injectable()
export class ReservationExpiredHandler implements EventHandler<ReservationExpiredEvent> {
  readonly kind = ORDER_RESERVATION_EXPIRED;

  constructor(
    private readonly orders: OrderRepository,
    private readonly reservations: ReservationRepository,
    private readonly redis: RedisConnection,
    private readonly metrics: Metrics,
    private readonly spans: Spans,
    private readonly logger: AppLogger,
  ) {}

  handle(event: ReservationExpiredEvent): Promise<void> {
    const orderId = event.data.order_id;
    return this.spans.run('reservation.expire', async () => {
      // Same advisory lock as activation: an expiry never races a checkout retry.
      const outcome = await this.orders.withActivationLock(orderId, (runner) =>
        this.inTransaction(runner, orderId),
      );

      if (outcome.result === 'not_found' || outcome.result === 'not_expired') {
        this.logger.warn('reservation.expire.ignored', {
          reason: outcome.result,
        });
        return;
      }
      if (outcome.result !== 'expired') {
        if (outcome.result === 'already_processed')
          this.metrics.reservations.inc({ result: 'already_processed' });
        this.logger.info('reservation.expire.skipped', {
          reason: outcome.result,
        });
        return;
      }

      await this.invalidateCatalog();
      this.metrics.reservations.inc({ result: 'expired' });
      this.metrics.processing.inc({ result: 'expired' });
      this.logger.info('reservation.expire.completed', {
        released_items: outcome.released,
      });
    });
  }

  private async inTransaction(
    runner: QueryRunner,
    orderId: string,
  ): Promise<ExpireOutcome> {
    await runner.startTransaction();
    try {
      const outcome = await this.expire(runner.manager, orderId);
      // Only a real expiry commits; every skip leaves the database untouched.
      if (outcome.result === 'expired') await runner.commitTransaction();
      else await runner.rollbackTransaction();
      return outcome;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }

  private async expire(
    manager: EntityManager,
    orderId: string,
  ): Promise<ExpireOutcome> {
    const order = await this.orders.lock(manager, orderId);
    if (!order) return { result: 'not_found' };
    if (order.processingStatus === ProcessingStatus.Completed)
      return { result: 'completed' };

    const affected = await this.orders.transitionStatus(
      manager,
      orderId,
      EXPIRABLE_ORDER_STATUSES,
      OrderStatus.Cancelled,
    );
    if (affected === 0) return { result: 'already_processed' };
    // Guards against a premature or forged event; the status change is rolled back.
    if (!(await this.reservations.hasExpired(manager, orderId)))
      return { result: 'not_expired' };

    const released = await this.reservations.release(manager, orderId);
    return { result: 'expired', released };
  }

  private async invalidateCatalog(): Promise<void> {
    try {
      if (!this.redis.client.isReady) throw new Error('Cache unavailable');
      await this.redis.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
        .del(CATALOG_KEY);
    } catch {
      // Stock is already committed; a cache miss must not trigger a Kafka retry.
      this.logger.warn('reservation.expire.cache_invalidation_failed');
    }
  }
}
