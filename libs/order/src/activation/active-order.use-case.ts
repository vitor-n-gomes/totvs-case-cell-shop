import { StepName } from './constants/step-names';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { CheckoutEvent, OrderStatus, ProcessingStatus } from '@app/contracts';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Spans } from '@app/platform/observability/spans';
import { OrderRepository } from '../repositories/order.repository';
import { OutboxRepository } from '../repositories/outbox.repository';
import { ReservationRepository } from '@app/shop/inventory/reservation.repository';
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
  async execute(event: CheckoutEvent): Promise<void> {
    return this.orders.withActivationLock(event.order_id, async (runner) => {
      const order = await this.orders.findById(event.order_id, runner.manager);
      if (!order) throw new PermanentActivationError('Unknown order');
      if (
        [ProcessingStatus.Completed, ProcessingStatus.Failed].includes(
          order.processingStatus,
        ) ||
        event.attempt <= order.lastAttempt
      )
        return;
      if (event.attempt !== order.lastAttempt + 1)
        throw new PermanentActivationError('Out-of-sequence attempt');
      const context: ActivationContext = {
        order,
        event,
        correlationId: event.correlation_id,
        manager: runner.manager,
        currentStep: StepName.ConsumeStockReservationStep,
      };
      try {
        await this.spans.run('order.activation', () =>
          this.strategy.execute(context, runner),
        );
        await this.orders.update(runner.manager, order.id, {
          processingStatus: ProcessingStatus.Completed,
          lastAttempt: event.attempt,
        });
        this.metrics.processing.inc({ result: 'completed' });
      } catch (error) {
        const terminal =
          error instanceof PermanentActivationError || event.attempt >= 5;
        await runner.startTransaction();
        try {
          const current = await this.orders.lockOrFail(
            runner.manager,
            order.id,
          );
          const reference = {
            error_type: error instanceof Error ? error.name : 'UnknownError',
            attempt: event.attempt,
            event_id: event.event_id,
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
            lastAttempt: event.attempt,
          });
          const topic = this.config.getOrThrow<string>('CHECKOUT_TOPIC');
          const nextEvent = {
            ...event,
            event_id: randomUUID(),
            occurred_at: new Date().toISOString(),
            attempt: terminal ? event.attempt : event.attempt + 1,
          };
          await this.outbox.append(
            runner.manager,
            order.id,
            terminal ? `${topic}.dlq` : topic,
            terminal
              ? {
                  ...nextEvent,
                  failure: reference,
                  failed_step: context.currentStep,
                }
              : nextEvent,
            `${order.id}:${terminal ? 'dlq' : 'attempt'}:${nextEvent.attempt}`,
            terminal ? 0 : 2 ** (event.attempt - 1),
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
          attempt: event.attempt,
          terminal,
        });
      }
    });
  }
}
