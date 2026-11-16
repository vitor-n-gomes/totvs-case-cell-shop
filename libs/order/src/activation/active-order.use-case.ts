import { Injectable } from '@nestjs/common';
import { CheckoutInitiatedEvent } from '@app/order/messaging/order-events';
import { ProcessingStatus } from '@app/order/domain/shared/types/order.type';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { OrderRepository } from '../repositories/order.repository';
import { StepName } from './constants/step-names';
import { OrderActivationGuard } from './guards/order-activation.guard';
import { ActivationFailureHandler } from './handlers/activation-failure.handler';
import { ActivationContext } from './steps/activation-step';
import { OnlineActivationStrategy } from './strategies/online-activation.strategy';

@Injectable()
export class ActiveOrderUseCase {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly orderActivationGuard: OrderActivationGuard,
    private readonly onlineActivationStrategy: OnlineActivationStrategy,
    private readonly activationFailureHandler: ActivationFailureHandler,
    private readonly metricsService: Metrics,
    private readonly spansService: Spans,
  ) {}

  async execute(event: CheckoutInitiatedEvent): Promise<void> {
    const { order_id: orderId } = event.data;
    const { attempt } = event.meta;

    return this.orderRepository.withActivationLock(
      orderId,
      async (queryRunner) => {
        const activationDecision = await this.orderActivationGuard.evaluate(
          orderId,
          attempt,
          queryRunner.manager,
        );

        if (activationDecision === 'skip') {

          return;

        }

        const order = await this.orderRepository.findById(
          orderId,
          queryRunner.manager,
        );

        if (!order) {

          return;

        }

        const activationContext: ActivationContext = {
          order,
          event,
          correlationId: event.meta.correlation_id,
          entityManager: queryRunner.manager,
          currentStep: StepName.ConsumeStockReservationStep,
        };

        try {

          await this.spansService.run('order.activation', () =>
            this.onlineActivationStrategy.execute(
              activationContext,
              queryRunner,
            ),
          );

          await this.orderRepository.update(queryRunner.manager, order.id, {
            processingStatus: ProcessingStatus.Completed,
            lastAttempt: attempt,
          });

          this.metricsService.processingCounter.inc({ result: 'completed' });

        } catch (error) {

          await this.activationFailureHandler.handle(
            queryRunner,
            order,
            activationContext,
            error,
          );

        }
      },
    );
  }
}
