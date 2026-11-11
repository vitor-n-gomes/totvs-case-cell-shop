import { QueryRunner } from 'typeorm';
import { OnlineActivationStrategy } from '@app/shop/activation/strategies/online-activation.strategy';
import { ActivationStepRegistry } from '@app/shop/activation/registries/activation-step.registry';
import { IdempotencyLogRepository } from '@app/shop/activation/idempotency-log.repository';
import { ActivationContext } from '@app/shop/activation/steps/activation-step';
import {
  STEP_NAMES,
  StepName,
} from '@app/shop/activation/constants/step-names';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';

function setup() {
  const order = { id: 'order', status: 'PENDING' };
  const calls: StepName[] = [];
  const steps = Object.fromEntries(
    STEP_NAMES.map((name) => [
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
  const strategy = new OnlineActivationStrategy(
    {
      get: (name: StepName) => steps[name],
    } as unknown as ActivationStepRegistry,
    journal as unknown as IdempotencyLogRepository,
    new Metrics(),
    new Spans({ info: jest.fn() } as unknown as AppLogger),
  );
  const context = {
    order,
    manager,
    event: { attempt: 1 },
    currentStep: STEP_NAMES[0],
    correlationId: 'correlation',
  } as unknown as ActivationContext;
  return { calls, steps, journal, runner, strategy, context };
}
describe('Activation orchestration', () => {
  it('runs the exact priority order and commits before external calls', async () => {
    const { calls, steps, runner, strategy, context } = setup();
    steps.UpdateErpStep.exec.mockImplementation(async () => {
      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
      calls.push('UpdateErpStep');
    });
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(calls).toEqual(STEP_NAMES);
  });
  it('skips successful steps and respects shouldExecute', async () => {
    const { calls, steps, journal, runner, strategy, context } = setup();
    journal.succeeded.mockImplementation(
      async (_manager: unknown, _id: string, name: StepName) =>
        name === 'ConsumeStockReservationStep',
    );
    steps.EmailNotificationStep.shouldExecute.mockReturnValue(false);
    await strategy.execute(context, runner as unknown as QueryRunner);
    expect(calls).toEqual(['ActivateOrderStep', 'UpdateErpStep']);
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
    expect(context.currentStep).toBe('UpdateErpStep');
  });
});
