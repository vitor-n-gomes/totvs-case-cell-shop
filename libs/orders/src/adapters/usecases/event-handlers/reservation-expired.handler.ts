import { Injectable } from '@nestjs/common';
import { EntityManager, QueryRunner } from 'typeorm';
import {
  EXPIRABLE_ORDER_STATUSES,
  OrderStatus,
  ProcessingStatus,
} from '../../../domain/shared/types/order.type';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { OrderRepository } from '../../../repositories/order.repository';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { CATALOG_KEY } from '@app/products/adapters/usecases/get-products.use-case';
import { EventHandler } from '../../handlers/event.handler';
import {
  ORDER_RESERVATION_EXPIRED,
  ReservationExpiredEvent,
} from '../../../messaging/order-events';

type ExpireOutcome =
  | { result: 'expired'; released: number }
  | { result: 'already_processed' | 'completed' | 'not_found' | 'not_expired' };

@Injectable()
export class ReservationExpiredHandler implements EventHandler<ReservationExpiredEvent> {
  readonly kind = ORDER_RESERVATION_EXPIRED;

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly reservationRepository: ReservationRepository,
    private readonly redisConnection: RedisConnection,
    private readonly metricsService: Metrics,
    private readonly spansService: Spans,
    private readonly appLogger: AppLogger,
  ) {}

  handle(event: ReservationExpiredEvent): Promise<void> {
    const orderId = event.data.order_id;

    return this.spansService.run('reservation.expire', async () => {
      // Same advisory lock as activation: an expiry never races a checkout retry.
      const expirationOutcome = await this.orderRepository.withActivationLock(
        orderId,
        (queryRunner) => this.inTransaction(queryRunner, orderId),
      );

      if (
        expirationOutcome.result === 'not_found' ||
        expirationOutcome.result === 'not_expired'
      ) {

        this.appLogger.warn('reservation.expire.ignored', {
          reason: expirationOutcome.result,
        });

        return;

      }

      if (expirationOutcome.result !== 'expired') {

        if (expirationOutcome.result === 'already_processed') {

          this.metricsService.reservationTransitionsCounter.inc({
            result: 'already_processed',
          });

        }

        this.appLogger.info('reservation.expire.skipped', {
          reason: expirationOutcome.result,
        });

        return;

      }

      await this.invalidateCatalog();

      this.metricsService.reservationTransitionsCounter.inc({
        result: 'expired',
      });

      this.metricsService.processingCounter.inc({ result: 'expired' });

      this.appLogger.info('reservation.expire.completed', {
        released_items: expirationOutcome.released,
      });
    });
  }

  private async inTransaction(
    queryRunner: QueryRunner,
    orderId: string,
  ): Promise<ExpireOutcome> {
    await queryRunner.startTransaction();

    try {

      const expirationOutcome = await this.expire(queryRunner.manager, orderId);

      // Only a real expiry commits; every skip leaves the database untouched.
      if (expirationOutcome.result === 'expired') {

        await queryRunner.commitTransaction();

      } else {

        await queryRunner.rollbackTransaction();

      }

      return expirationOutcome;

    } catch (error) {

      if (queryRunner.isTransactionActive) {

        await queryRunner.rollbackTransaction();

      }

      throw error;

    }
  }

  private async expire(
    entityManager: EntityManager,
    orderId: string,
  ): Promise<ExpireOutcome> {
    const order = await this.orderRepository.lock(entityManager, orderId);

    if (!order) {

      return { result: 'not_found' };

    }

    if (order.processingStatus === ProcessingStatus.Completed) {

      return { result: 'completed' };

    }

    const affectedOrderCount = await this.orderRepository.transitionStatus(
      entityManager,
      orderId,
      EXPIRABLE_ORDER_STATUSES,
      OrderStatus.Cancelled,
    );

    if (affectedOrderCount === 0) {

      return { result: 'already_processed' };

    }

    // Guards against a premature or forged event; the status change is rolled back.
    if (
      !(await this.reservationRepository.hasExpired(entityManager, orderId))
    ) {

      return { result: 'not_expired' };

    }

    const releasedReservationCount = await this.reservationRepository.release(
      entityManager,
      orderId,
    );

    return { result: 'expired', released: releasedReservationCount };
  }

  private async invalidateCatalog(): Promise<void> {
    try {

      if (!this.redisConnection.redisClient.isReady) {

        throw new Error('Cache unavailable');

      }

      await this.redisConnection.redisClient
        .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
        .del(CATALOG_KEY);

    } catch {

      // Stock is already committed; a cache miss must not trigger a Kafka retry.
      this.appLogger.warn('reservation.expire.cache_invalidation_failed');

    }
  }
}
