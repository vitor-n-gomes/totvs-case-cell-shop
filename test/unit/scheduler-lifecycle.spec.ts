import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { ExpireReservationsUseCase } from '@app/orders/adapters/usecases/expire-reservations.use-case';
import { OrderMessaging } from '@app/orders/adapters/order.messaging';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Spans } from '@app/platform/observability/spans';
import { checkoutEvent, loggerMock } from './support/fixtures';

describe('reservation scheduler lifecycle', () => {
  async function setup() {
    const repository = { expiredOrderIds: jest.fn().mockResolvedValue([]) };

    const messaging = {
      ensureConnected: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
    };

    const logger = loggerMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpireReservationsUseCase,
        SchedulerRegistry,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CHECKOUT_TOPIC: 'checkout',
            SCHEDULER_INTERVAL_MS: 1000,
          }),
        },
        { provide: ReservationRepository, useValue: repository },
        { provide: OrderMessaging, useValue: messaging },
        { provide: AppLogger, useValue: logger },
        { provide: Spans, useValue: new Spans(logger as unknown as AppLogger) },
      ],
    }).compile();

    return {
      scheduler: moduleRef.get(ExpireReservationsUseCase),
      registry: moduleRef.get(SchedulerRegistry),
      repository,
      messaging,
      logger,
    };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts once, runs immediately and stops its registered interval during shutdown', async () => {
    const { scheduler, registry, repository } = await setup();

    jest.useFakeTimers();
    scheduler.start();
    scheduler.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(repository.expiredOrderIds).toHaveBeenCalledTimes(1);
    expect(registry.getIntervals()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(repository.expiredOrderIds).toHaveBeenCalledTimes(2);
    await scheduler.beforeApplicationShutdown();
    expect(registry.getIntervals()).toEqual([]);
    await jest.advanceTimersByTimeAsync(2000);
    await scheduler.tick();
    expect(repository.expiredOrderIds).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([new Error('database down'), 'unknown failure'])(
    'recovers from a failed cycle %p on the next tick',
    async (failure) => {
      const { scheduler, repository, logger } = await setup();

      repository.expiredOrderIds.mockRejectedValueOnce(failure);
      await expect(scheduler.tick()).resolves.toBeUndefined();
      await scheduler.tick();
      expect(repository.expiredOrderIds).toHaveBeenCalledTimes(2);

      expect(logger.error).toHaveBeenCalledWith(
        'scheduler.expiration.cycle_failed',
        { error_type: failure instanceof Error ? 'Error' : 'UnknownError' },
      );
    },
  );

  it.each([new Error('broker down'), 'unknown failure'])(
    'continues publishing other expirations after failure %p',
    async (failure) => {
      const { scheduler, repository, messaging, logger } = await setup();

      const orderIds = [
        checkoutEvent().data.order_id,
        checkoutEvent().data.order_id,
      ];

      repository.expiredOrderIds.mockResolvedValue(orderIds);
      messaging.publish.mockRejectedValueOnce(failure);
      await expect(scheduler.execute()).resolves.toBe(1);
      expect(messaging.publish).toHaveBeenCalledTimes(2);

      expect(messaging.publish).toHaveBeenLastCalledWith(
        'checkout',
        orderIds[1],
        expect.objectContaining({ data: { order_id: orderIds[1] } }),
        expect.any(Object),
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'scheduler.expiration.publish_failed',
        { error_type: failure instanceof Error ? 'Error' : 'UnknownError' },
      );
    },
  );

  it('waits for the in-flight event on shutdown and stops before publishing the next one', async () => {
    const { scheduler, repository, messaging } = await setup();
    let finish!: () => void;
    let started!: () => void;

    const publicationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    repository.expiredOrderIds.mockResolvedValue([
      checkoutEvent().data.order_id,
      checkoutEvent().data.order_id,
    ]);

    messaging.publish.mockImplementationOnce(() => {
      started();

      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    const tick = scheduler.tick();

    await publicationStarted;
    let stopped = false;

    const shutdown = scheduler.beforeApplicationShutdown().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await tick;
    await shutdown;
    expect(stopped).toBe(true);
    expect(messaging.publish).toHaveBeenCalledTimes(1);
    await scheduler.tick();
    expect(repository.expiredOrderIds).toHaveBeenCalledTimes(1);
  });

  it('does not claim publication success if connecting to Kafka fails', async () => {
    const { scheduler, repository, messaging } = await setup();
    const failure = new Error('connection failed');

    repository.expiredOrderIds.mockResolvedValue([
      checkoutEvent().data.order_id,
    ]);

    messaging.ensureConnected.mockRejectedValue(failure);
    await expect(scheduler.execute()).rejects.toBe(failure);
    expect(messaging.publish).not.toHaveBeenCalled();
  });
});
