import { Test } from '@nestjs/testing';
import { QueryRunner } from 'typeorm';
import { ActiveOrderUseCase } from '@app/order/activation/active-order.use-case';
import { OrderActivationGuard } from '@app/order/activation/guards/order-activation.guard';
import {
  PermanentActivationError,
  OrderCancelledError,
} from '@app/order/activation/guards/activation-errors';
import { ActivationFailureHandler } from '@app/order/activation/handlers/activation-failure.handler';
import { OnlineActivationStrategy } from '@app/order/activation/strategies/online-activation.strategy';
import { ActivationStepRegistry } from '@app/order/activation/registries/activation-step.registry';
import { StepName } from '@app/order/activation/constants/step-names';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { IdempotencyLogRepository } from '@app/order/repositories/idempotency-log.repository';
import { EventBus } from '@app/order/adapters/handlers/event.bus';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { ORDER_ACTIVATED } from '@app/order/messaging/order-events';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';
import {
  activationFixture,
  loggerMock,
  orderFixture,
} from './support/fixtures';

describe('OrderActivationGuard', () => {
  async function setup() {
    const repository = {
      findById: jest.fn().mockResolvedValue(orderFixture()),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderActivationGuard,
        { provide: OrderRepository, useValue: repository },
      ],
    }).compile();

    return { guard: moduleRef.get(OrderActivationGuard), repository };
  }

  it('allows the next sequential attempt', async () => {
    const { guard, repository } = await setup();
    const { context } = activationFixture();

    repository.findById.mockResolvedValue(orderFixture({ lastAttempt: 2 }));

    await expect(
      guard.evaluate(context.order.id, 3, context.entityManager),
    ).resolves.toBe('proceed');
  });

  it.each([ProcessingStatus.Completed, ProcessingStatus.Failed])(
    'skips final processing status %s',
    async (processingStatus) => {
      const { guard, repository } = await setup();
      const { context } = activationFixture();

      repository.findById.mockResolvedValue(orderFixture({ processingStatus }));

      await expect(
        guard.evaluate(context.order.id, 1, context.entityManager),
      ).resolves.toBe('skip');
    },
  );

  it.each([1, 2])('skips a duplicate or stale attempt %s', async (attempt) => {
    const { guard, repository } = await setup();
    const { context } = activationFixture();

    repository.findById.mockResolvedValue(orderFixture({ lastAttempt: 2 }));

    await expect(
      guard.evaluate(context.order.id, attempt, context.entityManager),
    ).resolves.toBe('skip');
  });

  it('rejects an attempt that skips a sequence number', async () => {
    const { guard } = await setup();
    const { context } = activationFixture();

    await expect(
      guard.evaluate(context.order.id, 2, context.entityManager),
    ).rejects.toThrow('Out-of-sequence attempt');
  });

  it('rejects unknown orders permanently', async () => {
    const { guard, repository } = await setup();
    const { context } = activationFixture();

    repository.findById.mockResolvedValue(null);

    await expect(
      guard.evaluate(context.order.id, 1, context.entityManager),
    ).rejects.toBeInstanceOf(PermanentActivationError);
  });
});

describe('ActiveOrderUseCase', () => {
  async function setup() {
    const fixture = activationFixture();

    const repository = {
      withActivationLock: jest.fn(
        (_id: string, operation: (runner: QueryRunner) => Promise<void>) =>
          operation(fixture.queryRunner),
      ),
      findById: jest.fn().mockResolvedValue(fixture.order),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const guard = { evaluate: jest.fn().mockResolvedValue('proceed') };
    const strategy = { execute: jest.fn().mockResolvedValue(undefined) };
    const failureHandler = { handle: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ActiveOrderUseCase,
        Metrics,
        { provide: OrderRepository, useValue: repository },
        { provide: OrderActivationGuard, useValue: guard },
        { provide: OnlineActivationStrategy, useValue: strategy },
        { provide: ActivationFailureHandler, useValue: failureHandler },
        {
          provide: Spans,
          useValue: new Spans(loggerMock() as unknown as AppLogger),
        },
      ],
    }).compile();

    return {
      ...fixture,
      service: moduleRef.get(ActiveOrderUseCase),
      repository,
      guard,
      strategy,
      failureHandler,
      metric: jest.spyOn(moduleRef.get(Metrics).processingCounter, 'inc'),
    };
  }

  it('marks successful activation completed under the order lock', async () => {
    const { service, context, queryRunner, repository, strategy, metric } =
      await setup();

    await service.execute(context.event);

    expect(repository.withActivationLock).toHaveBeenCalledWith(
      context.order.id,
      expect.any(Function),
    );

    expect(strategy.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        order: context.order,
        event: context.event,
        entityManager: queryRunner.manager,
      }),
      queryRunner,
    );

    expect(repository.update).toHaveBeenCalledWith(
      queryRunner.manager,
      context.order.id,
      { processingStatus: ProcessingStatus.Completed, lastAttempt: 1 },
    );

    expect(metric).toHaveBeenCalledWith({ result: 'completed' });
  });

  it.each(['skip', 'missing'])(
    'does not activate when the decision is %s',
    async (reason) => {
      const { service, context, guard, repository, strategy, metric } =
        await setup();

      if (reason === 'skip') {

        guard.evaluate.mockResolvedValue('skip');

      } else {

        repository.findById.mockResolvedValue(null);

      }

      await service.execute(context.event);
      expect(strategy.execute).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
      expect(metric).not.toHaveBeenCalled();
    },
  );

  it('delegates a failed step to failure handling without marking completion', async () => {
    const {
      service,
      context,
      queryRunner,
      strategy,
      failureHandler,
      repository,
      metric,
    } = await setup();

    const failure = new Error('ERP unavailable');

    strategy.execute.mockRejectedValue(failure);
    await service.execute(context.event);

    expect(failureHandler.handle).toHaveBeenCalledWith(
      queryRunner,
      context.order,
      expect.objectContaining({ event: context.event }),
      failure,
    );

    expect(repository.update).not.toHaveBeenCalled();
    expect(metric).not.toHaveBeenCalled();
  });

  it('propagates failure journal errors for message redelivery', async () => {
    const { service, context, strategy, failureHandler } = await setup();
    const failure = new Error('cannot persist failure');

    strategy.execute.mockRejectedValue(new Error('ERP unavailable'));
    failureHandler.handle.mockRejectedValue(failure);
    await expect(service.execute(context.event)).rejects.toBe(failure);
  });
});

describe('OnlineActivationStrategy', () => {
  async function setup() {
    const fixture = activationFixture();

    const steps = Object.fromEntries(
      Object.values(StepName).map((name) => [
        name,
        {
          exec: jest.fn().mockResolvedValue(undefined),
          shouldExecute: jest.fn().mockReturnValue(true),
        },
      ]),
    ) as Record<StepName, { exec: jest.Mock; shouldExecute: jest.Mock }>;

    const repository = {
      lockOrFail: jest.fn().mockResolvedValue(fixture.order),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const journal = {
      succeeded: jest.fn().mockResolvedValue(false),
      record: jest.fn().mockResolvedValue(undefined),
    };

    const bus = { dispatch: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OnlineActivationStrategy,
        Metrics,
        {
          provide: ActivationStepRegistry,
          useValue: { get: (name: StepName) => steps[name] },
        },
        { provide: OrderRepository, useValue: repository },
        { provide: IdempotencyLogRepository, useValue: journal },
        { provide: EventBus, useValue: bus },
        {
          provide: Spans,
          useValue: new Spans(loggerMock() as unknown as AppLogger),
        },
      ],
    }).compile();

    return {
      ...fixture,
      service: moduleRef.get(OnlineActivationStrategy),
      steps,
      repository,
      journal,
      bus,
      metrics: moduleRef.get(Metrics),
    };
  }

  it('commits database steps before dispatching activation and executing integrations', async () => {
    const {
      service,
      context,
      queryRunner,
      runner,
      steps,
      journal,
      bus,
      metrics,
    } = await setup();

    const consumedMetric = jest.spyOn(
      metrics.reservationTransitionsCounter,
      'inc',
    );

    context.consumedReservationCount = 2;
    await service.execute(context, queryRunner);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();

    expect(
      steps[StepName.ActivateOrderStep].exec.mock.invocationCallOrder[0],
    ).toBeLessThan(runner.commitTransaction.mock.invocationCallOrder[0]!);

    expect(runner.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      bus.dispatch.mock.invocationCallOrder[0]!,
    );

    expect(bus.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      steps[StepName.UpdateErpStep].exec.mock.invocationCallOrder[0]!,
    );

    expect(bus.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: ORDER_ACTIVATED,
        data: { order_id: context.order.id },
      }),
    );

    expect(journal.record).toHaveBeenCalledTimes(4);
    expect(consumedMetric).toHaveBeenCalledWith({ result: 'consumed' }, 2);
    expect(context.currentStep).toBe(StepName.EmailNotificationStep);
  });

  it('skips journaled steps and avoids counting reservations twice', async () => {
    const { service, context, queryRunner, steps, journal, metrics } =
      await setup();

    const metric = jest.spyOn(metrics.reservationTransitionsCounter, 'inc');

    journal.succeeded.mockResolvedValue(true);
    await service.execute(context, queryRunner);

    for (const step of Object.values(steps)) {

      expect(step.exec).not.toHaveBeenCalled();

    }

    expect(journal.record).not.toHaveBeenCalled();
    expect(metric).not.toHaveBeenCalled();
  });

  it('honors a step eligibility predicate', async () => {
    const { service, context, queryRunner, steps, journal } = await setup();

    steps[StepName.EmailNotificationStep].shouldExecute.mockReturnValue(false);
    await service.execute(context, queryRunner);
    expect(steps[StepName.EmailNotificationStep].exec).not.toHaveBeenCalled();
    expect(journal.record).toHaveBeenCalledTimes(3);
  });

  it('supports steps without an eligibility predicate', async () => {
    const { service, context, queryRunner, steps } = await setup();

    Reflect.deleteProperty(steps[StepName.UpdateErpStep], 'shouldExecute');
    await service.execute(context, queryRunner);
    expect(steps[StepName.UpdateErpStep].exec).toHaveBeenCalledTimes(1);
  });

  it('rolls back a cancelled order without running steps', async () => {
    const { service, context, queryRunner, runner, steps, bus } = await setup();

    context.order.status = OrderStatus.Cancelled;

    await expect(service.execute(context, queryRunner)).rejects.toBeInstanceOf(
      OrderCancelledError,
    );

    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);

    expect(
      steps[StepName.ConsumeStockReservationStep].exec,
    ).not.toHaveBeenCalled();

    expect(bus.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    StepName.ConsumeStockReservationStep,
    StepName.ActivateOrderStep,
    StepName.UpdateErpStep,
    StepName.EmailNotificationStep,
  ])(
    'retains the failing step %s and rolls back only an active transaction',
    async (stepName) => {
      const { service, context, queryRunner, runner, steps, journal } =
        await setup();

      const failure = new Error('step failed');

      const databaseStep = [
        StepName.ConsumeStockReservationStep,
        StepName.ActivateOrderStep,
      ].includes(stepName);

      steps[stepName].exec.mockRejectedValue(failure);
      await expect(service.execute(context, queryRunner)).rejects.toBe(failure);
      expect(context.currentStep).toBe(stepName);

      expect(runner.rollbackTransaction).toHaveBeenCalledTimes(
        databaseStep ? 1 : 0,
      );

      expect(runner.commitTransaction).toHaveBeenCalledTimes(
        databaseStep ? 0 : 1,
      );

      expect(journal.record).not.toHaveBeenCalledWith(
        context.entityManager,
        context.order.id,
        stepName,
        true,
        expect.anything(),
        expect.anything(),
      );

      if (stepName !== StepName.EmailNotificationStep) {

        expect(
          steps[StepName.EmailNotificationStep].exec,
        ).not.toHaveBeenCalled();

      }
    },
  );
});
