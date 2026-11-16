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

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as AppLogger;
const spans = new Spans(logger);
const config = {
  getOrThrow: (key: string) =>
    ({ CHECKOUT_TOPIC: 'order.checkout.initiated', SCHEDULER_INTERVAL_MS: 10 })[
      key
    ],
} as unknown as ConfigService;

async function counter(metrics: Metrics, name: 'reservations' | 'processing') {
  const { values } = await metrics[name].get();
  return Object.fromEntries(values.map((v) => [v.labels.result, v.value]));
}

describe('ExpireReservationsUseCase (scheduler producer)', () => {
  it('publishes a schema-valid event per expired order keyed by order id, without touching state', async () => {
    const ids = [randomUUID(), randomUUID()];
    const reservations = {
      expiredOrderIds: jest.fn().mockResolvedValue(ids),
      release: jest.fn(),
    };
    const published: { topic: string; key: string; payload: object }[] = [];
    const messaging = {
      ensureConnected: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn((topic: string, key: string, payload: object) => {
        published.push({ topic, key, payload });
        return Promise.resolve();
      }),
    };
    const useCase = new ExpireReservationsUseCase(
      reservations as unknown as ReservationRepository,
      messaging as unknown as OrderMessaging,
      config,
      new SchedulerRegistry(),
      spans,
      logger,
    );

    await expect(useCase.execute()).resolves.toBe(2);

    expect(reservations.expiredOrderIds).toHaveBeenCalledWith(
      [OrderStatus.Pending],
      EXPIRATION_BATCH_SIZE,
    );
    expect(reservations.release).not.toHaveBeenCalled();
    expect(published.map((p) => p.key)).toEqual(ids);
    for (const { topic, key, payload } of published) {
      expect(topic).toBe('order.checkout.initiated');
      const event = parseOrderEvent(payload);
      expect(event?.kind).toBe(ORDER_RESERVATION_EXPIRED);
      expect(event?.data.order_id).toBe(key);
      expect(event?.meta?.trace_id).toMatch(/^[a-f0-9]{32}$/);
      expect(event?.meta?.parent_span_id).toMatch(/^[a-f0-9]{16}$/);
    }
  });

  it('skips a tick while the previous cycle is still running', async () => {
    let finish!: (ids: string[]) => void;
    const reservations = {
      expiredOrderIds: jest.fn(
        () => new Promise<string[]>((resolve) => (finish = resolve)),
      ),
    };
    const useCase = new ExpireReservationsUseCase(
      reservations as unknown as ReservationRepository,
      {} as OrderMessaging,
      config,
      new SchedulerRegistry(),
      spans,
      logger,
    );

    const first = useCase.tick();
    await useCase.tick();
    finish([]);
    await first;

    expect(reservations.expiredOrderIds).toHaveBeenCalledTimes(1);
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
    const runner = {
      manager: {},
      isTransactionActive: false,
      startTransaction: jest.fn(() => {
        runner.isTransactionActive = true;
        return Promise.resolve();
      }),
      commitTransaction: jest.fn(() => {
        runner.isTransactionActive = false;
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn(() => {
        runner.isTransactionActive = false;
        return Promise.resolve();
      }),
    };
    const orders = {
      withActivationLock: jest.fn(
        (_id: string, work: (r: QueryRunner) => Promise<unknown>) =>
          work(runner as unknown as QueryRunner),
      ),
      lock: jest.fn().mockResolvedValue({
        id: orderId,
        processingStatus: options.processingStatus ?? ProcessingStatus.Pending,
      }),
      transitionStatus: jest.fn().mockResolvedValue(options.affected ?? 1),
    };
    const reservations = {
      hasExpired: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(2),
    };
    const del = options.redisFails
      ? jest.fn().mockRejectedValue(new Error('down'))
      : jest.fn().mockResolvedValue(1);
    const redis = {
      client: { isReady: true, withCommandOptions: () => ({ del }) },
    };
    const metrics = new Metrics();
    const handler = new ReservationExpiredHandler(
      orders as unknown as OrderRepository,
      reservations as unknown as ReservationRepository,
      redis as unknown as RedisConnection,
      metrics,
      spans,
      logger,
    );
    return { handler, runner, orders, reservations, del, metrics };
  }

  it('cancels the order, releases stock, commits and invalidates the catalog', async () => {
    const { handler, runner, orders, reservations, del, metrics } = setup({});

    await handler.handle(event);

    expect(orders.withActivationLock).toHaveBeenCalledWith(
      orderId,
      expect.any(Function),
    );
    expect(orders.transitionStatus).toHaveBeenCalledWith(
      runner.manager,
      orderId,
      [OrderStatus.Pending],
      OrderStatus.Cancelled,
    );
    expect(reservations.release).toHaveBeenCalledWith(runner.manager, orderId);
    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(CATALOG_KEY);
    expect(await counter(metrics, 'reservations')).toEqual({ expired: 1 });
    expect(await counter(metrics, 'processing')).toEqual({ expired: 1 });
  });

  it('is idempotent: affected = 0 skips stock release and counts already_processed', async () => {
    const { handler, runner, reservations, del, metrics } = setup({
      affected: 0,
    });

    await handler.handle(event);

    expect(reservations.release).not.toHaveBeenCalled();
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'reservation.expire.skipped',
      expect.anything(),
    );
    expect(await counter(metrics, 'reservations')).toEqual({
      already_processed: 1,
    });
  });

  it('ignores orders whose processing already completed', async () => {
    const { handler, orders, reservations } = setup({
      processingStatus: ProcessingStatus.Completed,
    });

    await handler.handle(event);

    expect(orders.transitionStatus).not.toHaveBeenCalled();
    expect(reservations.release).not.toHaveBeenCalled();
  });

  it('does not fail (no Kafka retry) when Redis invalidation fails after commit', async () => {
    const { handler, runner, metrics } = setup({ redisFails: true });

    await expect(handler.handle(event)).resolves.toBeUndefined();

    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'reservation.expire.cache_invalidation_failed',
    );
    expect(await counter(metrics, 'reservations')).toEqual({ expired: 1 });
  });
});
