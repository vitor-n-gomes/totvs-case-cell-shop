import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { QueryRunner } from 'typeorm';
import {
  EXPIRATION_BATCH_SIZE,
  ExpireReservationsUseCase,
} from '@app/order/adapters/usecases/expire-reservations.use-case';
import { ReservationExpiredHandler } from '@app/order/adapters/usecases/event-handlers/reservation-expired.handler';
import { OrderMessaging } from '@app/order/adapters/order.messaging';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { createEventMeta } from '@app/order/messaging/event.util';
import {
  ORDER_RESERVATION_EXPIRED,
  parseOrderEvent,
} from '@app/order/messaging/order-events';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { CATALOG_KEY } from '@app/products/adapters/usecases/get-products.use-case';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';

const appLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as AppLogger;

const spansService = new Spans(appLogger);

const configService = {
  getOrThrow: (configKey: string) =>
    ({ CHECKOUT_TOPIC: 'order.checkout.initiated', SCHEDULER_INTERVAL_MS: 10 })[
      configKey
    ],
} as unknown as ConfigService;

async function counter(
  metricsService: Metrics,
  counterName: 'reservationTransitionsCounter' | 'processingCounter',
) {
  const { values } = await metricsService[counterName].get();

  return Object.fromEntries(
    values.map((metricSample) => [
      metricSample.labels.result,
      metricSample.value,
    ]),
  );
}

describe('ExpireReservationsUseCase (scheduler producer)', () => {
  it('publishes a schema-valid event per expired order keyed by order id, without touching state', async () => {
    const expiredOrderIds = [randomUUID(), randomUUID()];

    const reservationRepository = {
      expiredOrderIds: jest.fn().mockResolvedValue(expiredOrderIds),
      release: jest.fn(),
    };

    const publishedEvents: { topic: string; key: string; payload: object }[] =
      [];

    const orderMessaging = {
      ensureConnected: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn((topic: string, messageKey: string, payload: object) => {
        publishedEvents.push({ topic, key: messageKey, payload });

        return Promise.resolve();
      }),
    };

    const expireReservationsUseCase = new ExpireReservationsUseCase(
      reservationRepository as unknown as ReservationRepository,
      orderMessaging as unknown as OrderMessaging,
      configService,
      new SchedulerRegistry(),
      spansService,
      appLogger,
    );

    await expect(expireReservationsUseCase.execute()).resolves.toBe(2);

    expect(reservationRepository.expiredOrderIds).toHaveBeenCalledWith(
      [OrderStatus.Pending],
      EXPIRATION_BATCH_SIZE,
    );

    expect(reservationRepository.release).not.toHaveBeenCalled();

    expect(publishedEvents.map((publishedEvent) => publishedEvent.key)).toEqual(
      expiredOrderIds,
    );

    for (const { topic, key: messageKey, payload } of publishedEvents) {

      expect(topic).toBe('order.checkout.initiated');
      const event = parseOrderEvent(payload);

      expect(event?.kind).toBe(ORDER_RESERVATION_EXPIRED);
      expect(event?.data.order_id).toBe(messageKey);
      expect(event?.meta?.trace_id).toMatch(/^[a-f0-9]{32}$/);
      expect(event?.meta?.parent_span_id).toMatch(/^[a-f0-9]{16}$/);

    }
  });

  it('skips a tick while the previous cycle is still running', async () => {
    let resolveExpiredOrderIds!: (expiredOrderIds: string[]) => void;

    const reservationRepository = {
      expiredOrderIds: jest.fn(
        () =>
          new Promise<string[]>(
            (resolve) => (resolveExpiredOrderIds = resolve),
          ),
      ),
    };

    const expireReservationsUseCase = new ExpireReservationsUseCase(
      reservationRepository as unknown as ReservationRepository,
      {} as OrderMessaging,
      configService,
      new SchedulerRegistry(),
      spansService,
      appLogger,
    );

    const firstTickPromise = expireReservationsUseCase.tick();

    await expireReservationsUseCase.tick();
    resolveExpiredOrderIds([]);
    await firstTickPromise;

    expect(reservationRepository.expiredOrderIds).toHaveBeenCalledTimes(1);
  });
});

describe('ReservationExpiredHandler (consumer)', () => {
  const orderId = randomUUID();

  const event = {
    kind: ORDER_RESERVATION_EXPIRED,
    data: { order_id: orderId },
    meta: createEventMeta(randomUUID()),
  } as const;

  function setup(options: {
    processingStatus?: ProcessingStatus;
    affected?: number;
    redisFails?: boolean;
  }) {
    const queryRunner = {
      manager: {},
      isTransactionActive: false,
      startTransaction: jest.fn(() => {
        queryRunner.isTransactionActive = true;

        return Promise.resolve();
      }),
      commitTransaction: jest.fn(() => {
        queryRunner.isTransactionActive = false;

        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn(() => {
        queryRunner.isTransactionActive = false;

        return Promise.resolve();
      }),
    };

    const orderRepository = {
      withActivationLock: jest.fn(
        (
          _orderId: string,
          activationOperation: (queryRunner: QueryRunner) => Promise<unknown>,
        ) => activationOperation(queryRunner as unknown as QueryRunner),
      ),
      lock: jest.fn().mockResolvedValue({
        id: orderId,
        processingStatus: options.processingStatus ?? ProcessingStatus.Pending,
      }),
      transitionStatus: jest.fn().mockResolvedValue(options.affected ?? 1),
    };

    const reservationRepository = {
      hasExpired: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(2),
    };

    const deleteCacheMock = options.redisFails
      ? jest.fn().mockRejectedValue(new Error('down'))
      : jest.fn().mockResolvedValue(1);

    const redisConnection = {
      redisClient: {
        isReady: true,
        withCommandOptions: () => ({ del: deleteCacheMock }),
      },
    };

    const metricsService = new Metrics();

    const reservationExpiredHandler = new ReservationExpiredHandler(
      orderRepository as unknown as OrderRepository,
      reservationRepository as unknown as ReservationRepository,
      redisConnection as unknown as RedisConnection,
      metricsService,
      spansService,
      appLogger,
    );

    return {
      reservationExpiredHandler,
      queryRunner,
      orderRepository,
      reservationRepository,
      deleteCacheMock,
      metricsService,
    };
  }

  it('cancels the order, releases stock, commits and invalidates the catalog', async () => {
    const {
      reservationExpiredHandler,
      queryRunner,
      orderRepository,
      reservationRepository,
      deleteCacheMock,
      metricsService,
    } = setup({});

    await reservationExpiredHandler.handle(event);

    expect(orderRepository.withActivationLock).toHaveBeenCalledWith(
      orderId,
      expect.any(Function),
    );

    expect(orderRepository.transitionStatus).toHaveBeenCalledWith(
      queryRunner.manager,
      orderId,
      [OrderStatus.Pending],
      OrderStatus.Cancelled,
    );

    expect(reservationRepository.release).toHaveBeenCalledWith(
      queryRunner.manager,
      orderId,
    );

    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(deleteCacheMock).toHaveBeenCalledWith(CATALOG_KEY);

    expect(
      await counter(metricsService, 'reservationTransitionsCounter'),
    ).toEqual({ expired: 1 });

    expect(await counter(metricsService, 'processingCounter')).toEqual({
      expired: 1,
    });
  });

  it('is idempotent: affected = 0 skips stock release and counts already_processed', async () => {
    const {
      reservationExpiredHandler,
      queryRunner,
      reservationRepository,
      deleteCacheMock,
      metricsService,
    } = setup({
      affected: 0,
    });

    await reservationExpiredHandler.handle(event);

    expect(reservationRepository.release).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(deleteCacheMock).not.toHaveBeenCalled();

    expect(appLogger.info).toHaveBeenCalledWith(
      'reservation.expire.skipped',
      expect.anything(),
    );

    expect(
      await counter(metricsService, 'reservationTransitionsCounter'),
    ).toEqual({
      already_processed: 1,
    });
  });

  it('ignores orders whose processing already completed', async () => {
    const {
      reservationExpiredHandler,
      orderRepository,
      reservationRepository,
    } = setup({
      processingStatus: ProcessingStatus.Completed,
    });

    await reservationExpiredHandler.handle(event);

    expect(orderRepository.transitionStatus).not.toHaveBeenCalled();
    expect(reservationRepository.release).not.toHaveBeenCalled();
  });

  it('does not fail (no Kafka retry) when Redis invalidation fails after commit', async () => {
    const { reservationExpiredHandler, queryRunner, metricsService } = setup({
      redisFails: true,
    });

    await expect(
      reservationExpiredHandler.handle(event),
    ).resolves.toBeUndefined();

    expect(queryRunner.commitTransaction).toHaveBeenCalled();

    expect(appLogger.warn).toHaveBeenCalledWith(
      'reservation.expire.cache_invalidation_failed',
    );

    expect(
      await counter(metricsService, 'reservationTransitionsCounter'),
    ).toEqual({ expired: 1 });
  });
});
