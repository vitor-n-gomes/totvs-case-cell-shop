import { OrderStatus, ProcessingStatus } from '@app/contracts';
import { Injectable } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { EventBus } from '@app/order/adapters/handlers/event.bus';
import { OrderEvent } from '@app/order/domain/events';
import { StepName } from '../constants/step-names';
import { OrderCancelledError } from '../guards/activation-errors';
import { IdempotencyLogRepository } from '../../repositories/idempotency-log.repository';
import { ActivationStepRegistry } from '../registries/activation-step.registry';
import { ActivationContext } from '../steps/activation-step';

@Injectable()
export class OnlineActivationStrategy {
  readonly stepNames = Object.values(StepName);
  constructor(
    private readonly registry: ActivationStepRegistry,
    private readonly orders: OrderRepository,
    private readonly journal: IdempotencyLogRepository,
    private readonly metrics: Metrics,
    private readonly spans: Spans,
    private readonly eventBus: EventBus,
  ) {}
  async execute(
    context: ActivationContext,
    runner: QueryRunner,
  ): Promise<void> {
    await runner.startTransaction();
    try {
      context.order = await this.orders.lockOrFail(
        runner.manager,
        context.order.id,
      );
      if (context.order.status === OrderStatus.Cancelled)
        throw new OrderCancelledError('Order cancelled');
      await this.orders.update(runner.manager, context.order.id, {
        processingStatus: ProcessingStatus.Processing,
      });
      const consumedBefore = await this.journal.succeeded(
        context.manager,
        context.order.id,
        StepName.ConsumeStockReservationStep,
      );
      for (const name of this.stepNames.slice(0, 2))
        await this.runStep(name, context);
      await runner.commitTransaction();
      if (!consumedBefore)
        this.metrics.reservations.inc(
          { result: 'consumed' },
          context.consumedReservations ?? 0,
        );
      await this.eventBus.dispatch({
        kind: 'order.activated',
        data: { orderId: context.order.id },
        meta: {
          correlationId: context.event.correlation_id,
          traceId: context.event.trace_id,
          parentSpanId: context.event.parent_span_id,
          timestamp: Date.now(),
        },
      } as OrderEvent);
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
