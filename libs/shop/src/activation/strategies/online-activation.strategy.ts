import { Injectable } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { OrderEntity } from '../../entities';
import { STEP_NAMES, StepName } from '../constants/step-names';
import { OrderCancelledError } from '../guards/activation-errors';
import { IdempotencyLogRepository } from '../idempotency-log.repository';
import { ActivationStepRegistry } from '../registries/activation-step.registry';
import { ActivationContext } from '../steps/activation-step';

@Injectable()
export class OnlineActivationStrategy {
  readonly stepNames = STEP_NAMES;
  constructor(
    private readonly registry: ActivationStepRegistry,
    private readonly journal: IdempotencyLogRepository,
    private readonly metrics: Metrics,
    private readonly spans: Spans,
  ) {}
  async execute(
    context: ActivationContext,
    runner: QueryRunner,
  ): Promise<void> {
    await runner.startTransaction();
    try {
      context.order = await runner.manager
        .getRepository(OrderEntity)
        .findOneOrFail({
          where: { id: context.order.id },
          lock: { mode: 'pessimistic_write' },
        });
      if (context.order.status === 'CANCELLED')
        throw new OrderCancelledError('Order cancelled');
      await runner.manager.query(
        'UPDATE "order" SET processing_status=\'PROCESSING\' WHERE id=$1',
        [context.order.id],
      );
      const consumedBefore = await this.journal.succeeded(
        context.manager,
        context.order.id,
        'ConsumeStockReservationStep',
      );
      for (const name of this.stepNames.slice(0, 2))
        await this.runStep(name, context);
      await runner.commitTransaction();
      if (!consumedBefore)
        this.metrics.reservations.inc(
          { result: 'consumed' },
          context.consumedReservations ?? 0,
        );
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
    for (const name of this.stepNames.slice(2))
      await this.runStep(name, context);
  }
  private async runStep(
    name: StepName,
    context: ActivationContext,
  ): Promise<void> {
    context.currentStep = name;
    const step = this.registry.get(name);
    if (step.shouldExecute && !step.shouldExecute(context)) return;
    if (await this.journal.succeeded(context.manager, context.order.id, name))
      return;
    const end = this.metrics.steps.startTimer({ step: name });
    try {
      await this.spans.run(name, () => step.exec(context));
      await this.journal.record(
        context.manager,
        context.order.id,
        name,
        true,
        { attempt: context.event.attempt },
        'Step completed',
      );
      end({ result: 'success' });
    } catch (error) {
      end({ result: 'failure' });
      throw error;
    }
  }
}
