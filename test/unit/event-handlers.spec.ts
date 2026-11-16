import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EventBus } from '@app/order/adapters/handlers/event.bus';
import { HandlersRegistry } from '@app/order/adapters/handlers/handlers.registry';
import { OrderActivatedHandler } from '@app/order/adapters/handlers/order-activated.handler';
import { ReservationExpiredHandler } from '@app/order/adapters/usecases/event-handlers/reservation-expired.handler';
import { OrderMessaging } from '@app/order/adapters/order.messaging';
import { OrderRepository } from '@app/order/repositories/order.repository';
import {
  ORDER_ACTIVATED,
  ORDER_RESERVATION_EXPIRED,
  OrderActivatedEvent,
} from '@app/order/messaging/order-events';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { checkoutEvent, loggerMock, orderFixture } from './support/fixtures';

describe('EventBus', () => {
  async function setup(config: Record<string, unknown> = {}) {
    const logger = loggerMock();
    const publish = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventBus,
        { provide: AppLogger, useValue: logger },
        { provide: OrderMessaging, useValue: { publish } },
        { provide: ConfigService, useValue: new ConfigService(config) },
      ],
    }).compile();

    return { bus: moduleRef.get(EventBus), logger, publish };
  }

  it('does not fail or publish when a domain event has no subscribers', async () => {
    const { bus, publish, logger } = await setup();

    await expect(bus.dispatch(checkoutEvent())).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No handlers registered'),
      expect.any(Object),
    );
  });

  it('starts every subscriber without waiting for the first subscriber to finish', async () => {
    const { bus } = await setup();
    const event = checkoutEvent();
    let finish!: () => void;

    const slow = {
      kind: event.kind,
      handle: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };

    const fast = {
      kind: event.kind,
      handle: jest.fn().mockResolvedValue(undefined),
    };

    bus.register(slow);
    bus.register(fast);
    const dispatch = bus.dispatch(event);

    await Promise.resolve();
    expect(slow.handle).toHaveBeenCalledWith(event);
    expect(fast.handle).toHaveBeenCalledWith(event);
    finish();
    await dispatch;
  });

  it.each([new Error('async failure'), 'non-error failure'])(
    'isolates asynchronous subscriber failure %p',
    async (failure) => {
      const { bus, logger } = await setup();
      const event = checkoutEvent();

      const healthy = {
        kind: event.kind,
        handle: jest.fn().mockResolvedValue(undefined),
      };

      bus.register({
        kind: event.kind,
        handle: jest.fn().mockRejectedValue(failure),
      });

      bus.register(healthy);
      await expect(bus.dispatch(event)).resolves.toBeUndefined();
      expect(healthy.handle).toHaveBeenCalledWith(event);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Handler failed'),
        expect.objectContaining({
          error: failure instanceof Error ? failure.message : failure,
        }),
      );
    },
  );

  it('isolates synchronous subscriber throws and does not dispatch to other kinds', async () => {
    const { bus } = await setup();
    const event = checkoutEvent();

    const unrelated = {
      kind: ORDER_RESERVATION_EXPIRED,
      handle: jest.fn(),
    } as const;

    bus.register({
      kind: event.kind,
      handle: () => {
        throw new Error('synchronous failure');
      },
    });

    bus.register(unrelated);
    await expect(bus.dispatch(event)).resolves.toBeUndefined();
    expect(unrelated.handle).not.toHaveBeenCalled();
  });

  it.each([
    [{}, undefined, 'order.events'],
    [{ KAFKA_ORDER_TOPIC: 'configured' }, undefined, 'configured'],
    [{ KAFKA_ORDER_TOPIC: 'configured' }, 'explicit', 'explicit'],
  ] as const)(
    'publishes using config %p and topic %p',
    async (config, topic, expectedTopic) => {
      const { bus, publish } = await setup(config);
      const event = checkoutEvent();

      await bus.publish(event, topic);

      expect(publish).toHaveBeenCalledWith(
        expectedTopic,
        event.data.order_id,
        event,
      );
    },
  );

  it('propagates broker failures to the publisher', async () => {
    const { bus, publish } = await setup();
    const failure = new Error('broker unavailable');

    publish.mockRejectedValue(failure);
    await expect(bus.publish(checkoutEvent())).rejects.toBe(failure);
  });
});

describe('HandlersRegistry', () => {
  async function setup() {
    const logger = loggerMock();
    const bus = { register: jest.fn() };
    const expiration = { kind: ORDER_RESERVATION_EXPIRED, handle: jest.fn() };
    const activated = { kind: ORDER_ACTIVATED, handle: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        HandlersRegistry,
        { provide: AppLogger, useValue: logger },
        { provide: EventBus, useValue: bus },
        { provide: ReservationExpiredHandler, useValue: expiration },
        { provide: OrderActivatedHandler, useValue: activated },
      ],
    }).compile();

    return {
      registry: moduleRef.get(HandlersRegistry),
      logger,
      bus,
      expiration,
      activated,
    };
  }

  it('registers expiration and activation listeners on module initialization', async () => {
    const { registry, bus, expiration, activated, logger } = await setup();

    registry.onModuleInit();
    expect(bus.register.mock.calls).toEqual([[expiration], [activated]]);

    expect(logger.info).toHaveBeenCalledWith('handlers.registry.initialized', {
      registered_handlers: 2,
      total_handlers: 2,
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([new Error('registration failed'), 'registration failed'])(
    'reports partial registration and continues after %p',
    async (failure) => {
      const { registry, bus, activated, logger } = await setup();

      bus.register.mockImplementationOnce(() => {
        throw failure;
      });

      registry.registerAll(bus as unknown as EventBus);
      expect(bus.register).toHaveBeenLastCalledWith(activated);

      expect(logger.warn).toHaveBeenCalledWith(
        'handlers.registry.incomplete_registration',
        { registered_handlers: 1, total_handlers: 2, failed_handlers: 1 },
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'handlers.registry.registration_failed',
        expect.objectContaining({ error: 'registration failed' }),
      );
    },
  );
});

describe('OrderActivatedHandler', () => {
  async function setup() {
    const repository = {
      findById: jest.fn().mockResolvedValue(orderFixture()),
    };

    const logger = loggerMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderActivatedHandler,
        Metrics,
        { provide: OrderRepository, useValue: repository },
        { provide: AppLogger, useValue: logger },
      ],
    }).compile();

    return {
      handler: moduleRef.get(OrderActivatedHandler),
      repository,
      logger,
      metric: jest.spyOn(
        moduleRef.get(Metrics).reservationTransitionsCounter,
        'inc',
      ),
    };
  }

  const event: OrderActivatedEvent = {
    kind: ORDER_ACTIVATED,
    data: { order_id: 'order' },
  };

  it('counts activation when the order exists', async () => {
    const { handler, metric } = await setup();

    await handler.handle(event);
    expect(metric).toHaveBeenCalledWith({ result: 'activated' });
  });

  it('reports a missing order without counting activation', async () => {
    const { handler, repository, metric, logger } = await setup();

    repository.findById.mockResolvedValue(null);
    await handler.handle(event);
    expect(metric).not.toHaveBeenCalled();

    expect(logger.error).toHaveBeenCalledWith(
      'order.activated.handler.order_not_found',
      { order_id: 'order' },
    );
  });

  it('propagates lookup failures for the EventBus to isolate', async () => {
    const { handler, repository, metric } = await setup();
    const failure = new Error('database down');

    repository.findById.mockRejectedValue(failure);
    await expect(handler.handle(event)).rejects.toBe(failure);
    expect(metric).not.toHaveBeenCalled();
  });
});
