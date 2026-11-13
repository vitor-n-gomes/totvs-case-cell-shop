import { OrderStatus } from '@app/contracts';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { QueryRunner } from 'typeorm';
import { OnlineActivationStrategy } from '@app/order/activation/strategies/online-activation.strategy';
import { ActivationStepRegistry } from '@app/order/activation/registries/activation-step.registry';
import { IdempotencyLogRepository } from '@app/order/repositories/idempotency-log.repository';
import { ActivationContext } from '@app/order/activation/steps/activation-step';
import { StepName } from '@app/order/activation/constants/step-names';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';
import { EventBus } from '@app/order/adapters/handlers/event.bus';

function setup(overrides?: { eventBus?: Partial<EventBus> }) {
  const order = { id: 'order', status: OrderStatus.Pending };
  const calls: StepName[] = [];
  const steps = Object.fromEntries(
    Object.values(StepName).map((name) => [
      name,
      {
        exec: jest.fn(async () => {
          calls.push(name);
        }),
        shouldExecute: jest.fn(() => true),
      },
    ]),
  ) as Record<StepName, { exec: jest.Mock; shouldExecute: jest.Mock }>;
  const journal = {
    succeeded: jest.fn().mockResolvedValue(false),
    record: jest.fn().mockResolvedValue(undefined),
  };
  const manager = {
    query: jest.fn(),
    getRepository: () => ({ findOneOrFail: async () => order }),
  };
  const runner = {
    manager,
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
  };
  const mockEventBus = {
    dispatch: jest.fn().mockResolvedValue(undefined),
    ...overrides?.eventBus,
  };
  const strategy = new OnlineActivationStrategy(
    {
      get: (name: StepName) => steps[name],
    } as unknown as ActivationStepRegistry,
    {
      lockOrFail: jest.fn().mockResolvedValue(order),
      update: jest.fn(),
    } as unknown as OrderRepository,
    journal as unknown as IdempotencyLogRepository,
    new Metrics(),
    new Spans({ info: jest.fn() } as unknown as AppLogger),
    mockEventBus as unknown as EventBus,
  );
  const context = {
    order,
    manager,
    event: {
      attempt: 1,
      correlation_id: 'corr-123',
      trace_id: 'trace-456',
      parent_span_id: 'span-789',
    },
    currentStep: StepName.ConsumeStockReservationStep,
    correlationId: 'correlation',
  } as unknown as ActivationContext;
  return { calls, steps, journal, runner, strategy, context, mockEventBus };
}
describe('Activation orchestration', () => {
  it('runs the exact priority order and commits before external calls', async () => {
    const { calls, steps, runner, strategy, context } = setup();
    steps.UpdateErpStep.exec.mockImplementation(async () => {
      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
      calls.push(StepName.UpdateErpStep);
    });
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(calls).toEqual([
      StepName.ConsumeStockReservationStep,
      StepName.ActivateOrderStep,
      StepName.UpdateErpStep,
      StepName.EmailNotificationStep,
    ]);
  });
  it('skips successful steps and respects shouldExecute', async () => {
    const { calls, steps, journal, runner, strategy, context } = setup();
    journal.succeeded.mockImplementation(
      async (_manager: unknown, _id: string, name: StepName) =>
        name === StepName.ConsumeStockReservationStep,
    );
    steps.EmailNotificationStep.shouldExecute.mockReturnValue(false);
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(calls).toEqual([StepName.ActivateOrderStep, StepName.UpdateErpStep]);
  });
  it('stops at a database-step failure and rolls back before propagating it', async () => {
    const { steps, runner, strategy, context } = setup();
    steps.ActivateOrderStep.exec.mockRejectedValue(new Error('write failed'));
    await expect(
      strategy.execute(context, runner as unknown as QueryRunner),
    ).rejects.toThrow('write failed');
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(steps.UpdateErpStep.exec).not.toHaveBeenCalled();
  });
  it('stops before notification on an ERP failure', async () => {
    const { steps, runner, strategy, context } = setup();
    steps.UpdateErpStep.exec.mockRejectedValue(new Error('ERP offline'));
    await expect(
      strategy.execute(context, runner as unknown as QueryRunner),
    ).rejects.toThrow('ERP offline');
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(steps.EmailNotificationStep.exec).not.toHaveBeenCalled();
    expect(context.currentStep).toBe(StepName.UpdateErpStep);
  });
});

describe('EventBus Integration - order.activated event', () => {
  it('should dispatch order.activated event on success', async () => {
    const { runner, strategy, context, mockEventBus } = setup();
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(mockEventBus.dispatch).toHaveBeenCalledTimes(1);
    expect(mockEventBus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'order.activated',
        data: { orderId: 'order' },
      }),
    );
  });

  it('should include correct order ID in event data', async () => {
    const { runner, strategy, context, mockEventBus } = setup();
    context.order.id = 'order-xyz-123';
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(mockEventBus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { orderId: 'order-xyz-123' },
      }),
    );
  });

  it('should propagate correlation_id from CheckoutEvent', async () => {
    const { runner, strategy, context, mockEventBus } = setup();
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(mockEventBus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          correlationId: 'corr-123',
        }),
      }),
    );
  });

  it('should propagate trace_id from CheckoutEvent', async () => {
    const { runner, strategy, context, mockEventBus } = setup();
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(mockEventBus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          traceId: 'trace-456',
        }),
      }),
    );
  });

  it('should propagate parent_span_id from CheckoutEvent', async () => {
    const { runner, strategy, context, mockEventBus } = setup();
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(mockEventBus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          parentSpanId: 'span-789',
        }),
      }),
    );
  });

  it('should include timestamp in event meta', async () => {
    const { runner, strategy, context, mockEventBus } = setup();
    const beforeExecution = Date.now();
    await strategy.execute(context, runner as unknown as QueryRunner);
    const afterExecution = Date.now();

    expect(mockEventBus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          timestamp: expect.any(Number),
        }),
      }),
    );

    const eventCall = mockEventBus.dispatch.mock.calls[0][0];
    expect(eventCall.meta.timestamp).toBeGreaterThanOrEqual(beforeExecution);
    expect(eventCall.meta.timestamp).toBeLessThanOrEqual(afterExecution);
  });

  it('should have correct event structure with kind, data and meta', async () => {
    const { runner, strategy, context, mockEventBus } = setup();
    await strategy.execute(context, runner as unknown as QueryRunner);
    const eventCall = mockEventBus.dispatch.mock.calls[0][0];

    expect(eventCall).toHaveProperty('kind');
    expect(eventCall).toHaveProperty('data');
    expect(eventCall).toHaveProperty('meta');
    expect(eventCall.data).toHaveProperty('orderId');
    expect(eventCall.meta).toHaveProperty('correlationId');
    expect(eventCall.meta).toHaveProperty('traceId');
    expect(eventCall.meta).toHaveProperty('parentSpanId');
    expect(eventCall.meta).toHaveProperty('timestamp');
  });

  it('should NOT dispatch event on database step failure (rolled back)', async () => {
    const { steps, runner, strategy, context, mockEventBus } = setup();
    steps.ActivateOrderStep.exec.mockRejectedValue(new Error('write failed'));

    await expect(
      strategy.execute(context, runner as unknown as QueryRunner),
    ).rejects.toThrow('write failed');

    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(mockEventBus.dispatch).not.toHaveBeenCalled();
  });

  it('should NOT dispatch event on early step failure', async () => {
    const { steps, runner, strategy, context, mockEventBus } = setup();
    steps.ConsumeStockReservationStep.exec.mockRejectedValue(
      new Error('stock error'),
    );

    await expect(
      strategy.execute(context, runner as unknown as QueryRunner),
    ).rejects.toThrow('stock error');

    expect(mockEventBus.dispatch).not.toHaveBeenCalled();
  });

  it('should dispatch event even when external steps fail after commit', async () => {
    const { steps, runner, strategy, context, mockEventBus } = setup();
    steps.UpdateErpStep.exec.mockRejectedValue(new Error('ERP offline'));

    await expect(
      strategy.execute(context, runner as unknown as QueryRunner),
    ).rejects.toThrow('ERP offline');

    // Event should have been dispatched before ERP failure
    expect(mockEventBus.dispatch).toHaveBeenCalledTimes(1);
    expect(mockEventBus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'order.activated',
      }),
    );
  });

  it('should still execute steps normally when EventBus is present', async () => {
    const { calls, runner, strategy, context } = setup();

    await strategy.execute(context, runner as unknown as QueryRunner);

    expect(calls).toEqual([
      StepName.ConsumeStockReservationStep,
      StepName.ActivateOrderStep,
      StepName.UpdateErpStep,
      StepName.EmailNotificationStep,
    ]);
  });

  it('should still record metrics normally when EventBus is present', async () => {
    const { runner, strategy, context } = setup();
    const metrics = new Metrics();
    const metricsIncSpy = jest.spyOn(
      metrics.reservations,
      'inc',
    );

    const strategyWithMetrics = new OnlineActivationStrategy(
      {
        get: (name: StepName) => ({
          exec: jest.fn(),
          shouldExecute: jest.fn(() => true),
        }),
      } as unknown as ActivationStepRegistry,
      {
        lockOrFail: jest.fn().mockResolvedValue(context.order),
        update: jest.fn(),
      } as unknown as OrderRepository,
      {
        succeeded: jest.fn().mockResolvedValue(false),
        record: jest.fn(),
      } as unknown as IdempotencyLogRepository,
      metrics,
      new Spans({ info: jest.fn() } as unknown as AppLogger),
      {
        dispatch: jest.fn().mockResolvedValue(undefined),
      } as unknown as EventBus,
    );

    await strategyWithMetrics.execute(
      context,
      runner as unknown as QueryRunner,
    );

    expect(metricsIncSpy).toHaveBeenCalledWith(
      { result: 'consumed' },
      expect.any(Number),
    );
  });
});

