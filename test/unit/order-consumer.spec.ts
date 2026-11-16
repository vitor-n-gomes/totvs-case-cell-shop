import { Test } from '@nestjs/testing';
import { KafkaContext, RpcException } from '@nestjs/microservices';
import { OrderConsumer } from '@app/order/adapters/consumer/order.consumer';
import { ProcessOrderEventUseCase } from '@app/order/adapters/usecases/process-order-event.use-case';
import { CheckoutInitiatedHandler } from '@app/order/adapters/usecases/event-handlers/checkout-initiated.handler';
import { ReservationExpiredHandler } from '@app/order/adapters/usecases/event-handlers/reservation-expired.handler';
import { ORDER_RESERVATION_EXPIRED } from '@app/order/messaging/order-events';
import { AppLogger } from '@app/platform/logging/app-logger';
import { executionContext } from '@app/platform/observability/context';
import { checkoutEvent, loggerMock } from './support/fixtures';

describe('ProcessOrderEventUseCase', () => {
  async function setup() {
    const checkout = { execute: jest.fn().mockResolvedValue(undefined) };
    const expiration = { handle: jest.fn().mockResolvedValue(undefined) };
    const logger = loggerMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProcessOrderEventUseCase,
        { provide: CheckoutInitiatedHandler, useValue: checkout },
        { provide: ReservationExpiredHandler, useValue: expiration },
        { provide: AppLogger, useValue: logger },
      ],
    }).compile();

    return {
      service: moduleRef.get(ProcessOrderEventUseCase),
      checkout,
      expiration,
      logger,
    };
  }

  it('dispatches checkout with event tracing and restores the caller context', async () => {
    const { service, checkout, expiration } = await setup();
    const event = checkoutEvent();
    let observedContext;

    checkout.execute.mockImplementation(async () => {
      observedContext = executionContext.getStore();
    });

    await service.handle(event);

    expect(observedContext).toMatchObject({
      order_id: event.data.order_id,
      correlation_id: event.meta.correlation_id,
      trace_id: event.meta.trace_id,
      parent_span_id: event.meta.parent_span_id,
      span_id: expect.stringMatching(/^[a-f0-9]{16}$/),
    });

    expect(executionContext.getStore()).toBeUndefined();
    expect(checkout.execute).toHaveBeenCalledWith(event);
    expect(expiration.handle).not.toHaveBeenCalled();
  });

  it('generates trace context for expiration events without metadata', async () => {
    const { service, checkout, expiration } = await setup();

    const event = {
      kind: ORDER_RESERVATION_EXPIRED,
      data: checkoutEvent().data,
    } as const;

    let observedContext;

    expiration.handle.mockImplementation(async () => {
      observedContext = executionContext.getStore();
    });

    await service.handle(event);

    expect(observedContext).toMatchObject({
      correlation_id: expect.any(String),
      trace_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      order_id: event.data.order_id,
    });

    expect(checkout.execute).not.toHaveBeenCalled();
  });

  it.each([new Error('failed'), 'non-error failure'])(
    'logs and propagates handler failures %p',
    async (failure) => {
      const { service, checkout, logger } = await setup();

      checkout.execute.mockRejectedValue(failure);
      await expect(service.handle(checkoutEvent())).rejects.toBe(failure);

      expect(logger.error).toHaveBeenCalledWith('order.event.dispatch.failed', {
        error_type: failure instanceof Error ? 'Error' : 'UnknownError',
      });

      expect(executionContext.getStore()).toBeUndefined();
    },
  );
});

describe('OrderConsumer heartbeat lifecycle', () => {
  async function setup() {
    const handler = { handle: jest.fn().mockResolvedValue(undefined) };
    const heartbeat = jest.fn().mockResolvedValue(undefined);

    const context = {
      getHeartbeat: () => heartbeat,
    } as unknown as KafkaContext;

    const moduleRef = await Test.createTestingModule({
      controllers: [OrderConsumer],
      providers: [{ provide: ProcessOrderEventUseCase, useValue: handler }],
    }).compile();

    return {
      consumer: moduleRef.get(OrderConsumer),
      handler,
      heartbeat,
      context,
    };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([null, {}, { kind: 'UNKNOWN' }])(
    'rejects malformed payload %p and cleans up heartbeat timers',
    async (payload) => {
      const { consumer, handler, context } = await setup();

      jest.useFakeTimers();

      await expect(
        consumer.orderEvent(payload, context),
      ).rejects.toBeInstanceOf(RpcException);

      expect(handler.handle).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('keeps a long-running event alive and clears the heartbeat after completion', async () => {
    const { consumer, handler, context, heartbeat } = await setup();
    let finish!: () => void;

    handler.handle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    jest.useFakeTimers();
    const operation = consumer.orderEvent(checkoutEvent(), context);

    await jest.advanceTimersByTimeAsync(2000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    finish();
    await operation;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('tolerates heartbeat failure and propagates the actual handler failure', async () => {
    const { consumer, handler, context, heartbeat } = await setup();
    let fail!: (error: Error) => void;
    const failure = new Error('handler failed');

    handler.handle.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );

    heartbeat.mockRejectedValue(new Error('heartbeat unavailable'));
    jest.useFakeTimers();

    const rejected = expect(
      consumer.orderEvent(checkoutEvent(), context),
    ).rejects.toBe(failure);

    await jest.advanceTimersByTimeAsync(1000);
    fail(failure);
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });
});
