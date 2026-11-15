import { StepName } from './constants/step-names';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  CheckoutFailedEvent,
  CheckoutInitiatedEvent,
  ORDER_CHECKOUT_FAILED,
  ORDER_CHECKOUT_INITIATED,
} from '@app/order/messaging/order-events';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Spans } from '@app/platform/observability/spans';
import { OrderRepository } from '../repositories/order.repository';
import { OutboxRepository } from '../repositories/outbox.repository';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { PermanentActivationError } from './guards/activation-errors';
import { IdempotencyLogRepository } from '../repositories/idempotency-log.repository';
import { ActivationContext } from './steps/activation-step';
import { OnlineActivationStrategy } from './strategies/online-activation.strategy';

@Injectable()
export class ActiveOrderUseCase {
  constructor(
    private readonly orders: OrderRepository,
    private readonly strategy: OnlineActivationStrategy,
    private readonly journal: IdempotencyLogRepository,
    private readonly outbox: OutboxRepository,
    private readonly reservations: ReservationRepository,
    private readonly config: ConfigService,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly spans: Spans,
  ) {}

  async execute(event: CheckoutInitiatedEvent): Promise<void> {
    const { order_id: orderId } = event.data;
    const { attempt } = event.meta;
    return this.orders.withActivationLock(orderId, async (runner) => {
      const order = await this.orders.findById(orderId, runner.manager);
      if (!order) throw new PermanentActivationError('Unknown order');
      if (
        [ProcessingStatus.Completed, ProcessingStatus.Failed].includes(
          order.processingStatus,
        ) ||
        attempt <= order.lastAttempt
      )
        return;
      if (attempt !== order.lastAttempt + 1)
        throw new PermanentActivationError('Out-of-sequence attempt');
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
        const terminal =
          error instanceof PermanentActivationError || attempt >= 5;
        await runner.startTransaction();
        try {
          const current = await this.orders.lockOrFail(
            runner.manager,
            order.id,
          );
          const reference = {
            error_type: error instanceof Error ? error.name : 'UnknownError',
            attempt,
            event_id: event.meta.event_id,
          };
          await this.journal.record(
            runner.manager,
            order.id,
            context.currentStep,
            false,
            reference,
            terminal
              ? 'Failed; dead letter scheduled'
              : 'Failed; retry scheduled',
          );
          if (terminal && current.status === OrderStatus.Pending) {
            await this.reservations.release(runner.manager, order.id);
            await this.orders.update(runner.manager, order.id, {
              status: OrderStatus.Cancelled,
            });
          }
          await this.orders.update(runner.manager, order.id, {
            processingStatus: terminal
              ? ProcessingStatus.Failed
              : ProcessingStatus.Retrying,
            lastAttempt: attempt,
          });
          const topic = this.config.getOrThrow<string>('CHECKOUT_TOPIC');
          const nextMeta = {
            ...event.meta,
            event_id: randomUUID(),
            occurred_at: new Date().toISOString(),
            attempt: terminal ? attempt : attempt + 1,
          };
          const nextEvent: CheckoutInitiatedEvent | CheckoutFailedEvent =
            terminal
              ? {
                  kind: ORDER_CHECKOUT_FAILED,
                  data: {
                    order_id: order.id,
                    failure: reference,
                    failed_step: context.currentStep,
                  },
                  meta: nextMeta,
                }
              : {
                  kind: ORDER_CHECKOUT_INITIATED,
                  data: { order_id: order.id },
                  meta: nextMeta,
                };
          await this.outbox.append(
            runner.manager,
            order.id,
            terminal ? `${topic}.dlq` : topic,
            nextEvent,
            `${order.id}:${terminal ? 'dlq' : 'attempt'}:${nextMeta.attempt}`,
            terminal ? 0 : 2 ** (attempt - 1),
          );
          await runner.commitTransaction();
        } catch (failure) {
          await runner.rollbackTransaction();
          throw failure;
        }
        this.metrics.processing.inc({ result: terminal ? 'dlq' : 'retry' });
        this.logger.warn('order.activation.failed', {
          order_id: order.id,
          step: context.currentStep,
          attempt,
          terminal,
        });
      }
    });
  }
}
