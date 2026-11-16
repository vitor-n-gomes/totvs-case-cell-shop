import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { Injectable } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { EventBus } from '@app/order/adapters/handlers/event.bus';
import {
  ORDER_ACTIVATED,
  OrderActivatedEvent,
} from '@app/order/messaging/order-events';
import { createEventMeta } from '@app/order/messaging/event.util';
import { StepName } from '../constants/step-names';
import { OrderCancelledError } from '../guards/activation-errors';
import { IdempotencyLogRepository } from '../../repositories/idempotency-log.repository';
import { ActivationStepRegistry } from '../registries/activation-step.registry';
import { ActivationContext } from '../steps/activation-step';

@Injectable()
export class OnlineActivationStrategy {
  readonly stepNames = Object.values(StepName);

  constructor(
    private readonly activationStepRegistry: ActivationStepRegistry,
    private readonly orderRepository: OrderRepository,
    private readonly idempotencyLogRepository: IdempotencyLogRepository,
    private readonly metricsService: Metrics,
    private readonly spansService: Spans,
    private readonly eventBus: EventBus,
  ) {}

  async execute(
    activationContext: ActivationContext,
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.startTransaction();

    try {

      activationContext.order = await this.orderRepository.lockOrFail(
        queryRunner.manager,
        activationContext.order.id,
      );

      if (activationContext.order.status === OrderStatus.Cancelled) {

        throw new OrderCancelledError('Order cancelled');

      }

      await this.orderRepository.update(
        queryRunner.manager,
        activationContext.order.id,
        {
          processingStatus: ProcessingStatus.Processing,
        },
      );

      const wasReservationConsumed =
        await this.idempotencyLogRepository.succeeded(
          activationContext.entityManager,
          activationContext.order.id,
          StepName.ConsumeStockReservationStep,
        );

      for (const stepName of this.stepNames.slice(0, 2)) {

        await this.runStep(stepName, activationContext);

      }

      await queryRunner.commitTransaction();

      if (!wasReservationConsumed) {

        this.metricsService.reservationTransitionsCounter.inc(
          { result: 'consumed' },
          activationContext.consumedReservationCount ?? 0,
        );

      }

    } catch (error) {

      // The transaction is already closed if the failure came after the commit.
      if (queryRunner.isTransactionActive) {

        await queryRunner.rollbackTransaction();

      }

      throw error;

    }

    // Best-effort notification: EventBus swallows handler errors.
    const orderActivatedEvent: OrderActivatedEvent = {
      kind: ORDER_ACTIVATED,
      data: { order_id: activationContext.order.id },
      meta: createEventMeta(activationContext.correlationId),
    };

    await this.eventBus.dispatch(orderActivatedEvent);

    for (const stepName of this.stepNames.slice(2)) {

      await this.runStep(stepName, activationContext);

    }
  }

  private async runStep(
    stepName: StepName,
    activationContext: ActivationContext,
  ): Promise<void> {
    activationContext.currentStep = stepName;

    const activationStep = this.activationStepRegistry.get(stepName);

    if (
      activationStep.shouldExecute &&
      !activationStep.shouldExecute(activationContext)
    ) {

      return;

    }

    if (
      await this.idempotencyLogRepository.succeeded(
        activationContext.entityManager,
        activationContext.order.id,
        stepName,
      )
    ) {

      return;

    }

    const stopStepTimer =
      this.metricsService.activationStepDurationHistogram.startTimer({
        step: stepName,
      });

    try {

      await this.spansService.run(stepName, () =>
        activationStep.exec(activationContext),
      );

      await this.idempotencyLogRepository.record(
        activationContext.entityManager,
        activationContext.order.id,
        stepName,
        true,
        { attempt: activationContext.event.meta.attempt },
        'Step completed',
      );

      stopStepTimer({ result: 'success' });

    } catch (error) {

      stopStepTimer({ result: 'failure' });

      throw error;

    }
  }
}
