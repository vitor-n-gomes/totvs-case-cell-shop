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
    private readonly orders: OrderRepository,
    private readonly guard: OrderActivationGuard,
    private readonly strategy: OnlineActivationStrategy,
    private readonly failureHandler: ActivationFailureHandler,
    private readonly metrics: Metrics,
    private readonly spans: Spans,
  ) {}

  async execute(event: CheckoutInitiatedEvent): Promise<void> {
    const { order_id: orderId } = event.data;
    const { attempt } = event.meta;

    return this.orders.withActivationLock(orderId, async (runner) => {
      const decision = await this.guard.evaluate(
        orderId,
        attempt,
        runner.manager,
      );

      if (decision === 'skip') return;

      const order = await this.orders.findById(orderId, runner.manager);

      if (!order) return;

      const context: ActivationContext = {
        order,
        event,
        correlationId: event.meta.correlation_id,
        manager: runner.manager,
        currentStep: StepName.ConsumeStockReservationStep,
      };

      try {
        await this.spans.run('order.activation', () =>
          this.strategy.execute(context, runner),
        );

        await this.orders.update(runner.manager, order.id, {
          processingStatus: ProcessingStatus.Completed,
          lastAttempt: attempt,
        });

        this.metrics.processing.inc({ result: 'completed' });
      } catch (error) {
        await this.failureHandler.handle(runner, order, context, error);
      }
    });
  }
}
