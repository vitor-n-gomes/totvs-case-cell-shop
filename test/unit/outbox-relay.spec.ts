import { Test } from '@nestjs/testing';
import { OutboxRelay } from '@app/orders/messaging/outbox-relay';
import { OutboxRepository } from '@app/orders/repositories/outbox.repository';
import { OrderMessaging } from '@app/orders/adapters/order.messaging';
import { ORDER_RESERVATION_EXPIRED } from '@app/orders/messaging/order-events';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';
import { executionContext } from '@app/platform/observability/context';
import { checkoutEvent, loggerMock } from './support/fixtures';

function claimedEvent() {
  const event = checkoutEvent();

  return {
    id: event.meta.event_id,
    orderId: event.data.order_id,
    topic: 'checkout',
    payload: event,
    leaseToken: 'lease',
  };
}

describe('OutboxRelay', () => {
  async function setup() {
    const events = [claimedEvent(), claimedEvent()];

    const repository = {
      backlog: jest.fn().mockResolvedValue({ count: 2, ageSeconds: 5 }),
      claim: jest.fn().mockResolvedValue(events),
      acknowledge: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const messaging = {
      ensureConnected: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
    };

    const logger = loggerMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboxRelay,
        Metrics,
        { provide: OutboxRepository, useValue: repository },
        { provide: OrderMessaging, useValue: messaging },
        { provide: AppLogger, useValue: logger },
        { provide: Spans, useValue: new Spans(logger as unknown as AppLogger) },
      ],
    }).compile();

    return {
      service: moduleRef.get(OutboxRelay),
      repository,
      messaging,
      logger,
      events,
      metrics: moduleRef.get(Metrics),
    };
  }

  it('publishes a batch with correlation context and acknowledges each delivery', async () => {
    const { service, repository, messaging, events, metrics } = await setup();
    const publishedContexts: unknown[] = [];
    const gauge = jest.spyOn(metrics.outboxBacklogGauge, 'set');

    messaging.publish.mockImplementation(async () => {
      publishedContexts.push(executionContext.getStore());
    });

    repository.backlog
      .mockResolvedValueOnce({ count: 2, ageSeconds: 5 })
      .mockResolvedValueOnce({ count: 0, ageSeconds: 0 });

    await service.execute();
    expect(repository.acknowledge).toHaveBeenCalledTimes(2);
    expect(repository.release).not.toHaveBeenCalled();
    expect(gauge).toHaveBeenLastCalledWith(0);

    for (const event of events) {

      expect(messaging.publish).toHaveBeenCalledWith(
        event.topic,
        event.orderId,
        event.payload,
        { 'X-Correlation-Id': event.payload.meta.correlation_id },
      );

      expect(repository.acknowledge).toHaveBeenCalledWith(event);

      expect(publishedContexts).toContainEqual(
        expect.objectContaining({
          correlation_id: event.payload.meta.correlation_id,
          order_id: event.orderId,
          trace_id: event.payload.meta.trace_id,
        }),
      );

    }
  });

  it('releases a failed publication while allowing the rest of the batch to succeed', async () => {
    const { service, repository, messaging, events } = await setup();

    messaging.publish.mockRejectedValueOnce(new Error('Kafka unavailable'));
    await service.execute();
    expect(repository.release).toHaveBeenCalledWith(events[0]);
    expect(repository.acknowledge).toHaveBeenCalledTimes(1);
    expect(repository.acknowledge).toHaveBeenCalledWith(events[1]);
  });

  it('releases the lease when acknowledgement fails after publication', async () => {
    const { service, repository, events, messaging } = await setup();

    repository.acknowledge.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await service.execute();
    expect(messaging.publish).toHaveBeenCalledTimes(2);
    expect(repository.release).toHaveBeenCalledWith(events[0]);
  });

  it('propagates release failures after finishing the remaining batch', async () => {
    const { service, repository, messaging, events } = await setup();
    const failure = new Error('cannot release');

    messaging.publish.mockRejectedValueOnce(new Error('Kafka unavailable'));
    repository.release.mockRejectedValue(failure);
    await expect(service.execute()).rejects.toBe(failure);
    expect(repository.acknowledge).toHaveBeenCalledWith(events[1]);
  });

  it.each([
    { kind: 'UNKNOWN' },
    {
      kind: ORDER_RESERVATION_EXPIRED,
      data: { order_id: checkoutEvent().data.order_id },
    },
  ])(
    'rejects an invalid outbox payload while completing valid deliveries: %p',
    async (payload) => {
      const { service, repository, events, messaging } = await setup();

      repository.claim.mockResolvedValue([
        { ...events[0], payload },
        events[1],
      ]);

      await expect(service.execute()).rejects.toThrow(
        /Invalid order event|without meta/,
      );

      expect(messaging.publish).toHaveBeenCalledTimes(1);
      expect(repository.acknowledge).toHaveBeenCalledWith(events[1]);
    },
  );

  it('does not claim work when Kafka connection fails', async () => {
    const { service, repository, messaging } = await setup();
    const failure = new Error('connection unavailable');

    messaging.ensureConnected.mockRejectedValue(failure);
    await expect(service.execute()).rejects.toBe(failure);
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('does not publish when the backlog has no claimable events', async () => {
    const { service, repository, messaging } = await setup();

    repository.claim.mockResolvedValue([]);
    await service.execute();
    expect(messaging.publish).not.toHaveBeenCalled();
    expect(repository.backlog).toHaveBeenCalledTimes(2);
  });

  it('logs a failed cycle and permits a later tick to retry', async () => {
    const { service, repository, logger } = await setup();

    repository.backlog.mockRejectedValueOnce(new Error('database unavailable'));
    await service.tick();
    expect(logger.error).toHaveBeenCalledWith('outbox.relay.failed');
    await service.tick();
    expect(repository.claim).toHaveBeenCalledTimes(1);
  });

  it('prevents overlapping ticks and waits for in-flight work before shutdown', async () => {
    const { service, repository } = await setup();
    let finish!: () => void;

    repository.claim.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        }),
    );

    const tick = service.tick();

    await Promise.resolve();
    await Promise.resolve();
    await service.tick();
    expect(repository.claim).toHaveBeenCalledTimes(1);
    let stopped = false;

    const shutdown = service.beforeApplicationShutdown().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await tick;
    await shutdown;
    await service.tick();
    expect(stopped).toBe(true);
    expect(repository.claim).toHaveBeenCalledTimes(1);
  });
});
