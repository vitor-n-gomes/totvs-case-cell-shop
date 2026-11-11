import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CheckoutEvent } from '@app/contracts';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Spans } from '@app/platform/observability/spans';
import { OrderEntity } from '../entities';
import { OutboxRepository } from '../messaging/outbox.repository';
import { ReservationRepository } from '../inventory/reservation.repository';
import { PermanentActivationError } from './guards/activation-errors';
import { IdempotencyLogRepository } from './idempotency-log.repository';
import { ActivationContext } from './steps/activation-step';
import { OnlineActivationStrategy } from './strategies/online-activation.strategy';

@Injectable()
export class ActiveOrderUseCase {
  constructor(
    private readonly database: DataSource,
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
    const runner = this.database.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      await runner.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        event.order_id,
      ]);
      locked = true;
      const order = await runner.manager.findOneBy(OrderEntity, {
        id: event.order_id,
      });
      if (!order) throw new PermanentActivationError('Unknown order');
      if (
        ['COMPLETED', 'FAILED'].includes(order.processingStatus) ||
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
        currentStep: 'ConsumeStockReservationStep',
      };
      try {
        await this.spans.run('order.activation', () =>
          this.strategy.execute(context, runner),
        );
        await runner.manager.query(
          'UPDATE "order" SET processing_status=\'COMPLETED\',last_attempt=$2 WHERE id=$1',
          [order.id, event.attempt],
        );
        this.metrics.processing.inc({ result: 'completed' });
      } catch (error) {
        const terminal =
          error instanceof PermanentActivationError || event.attempt >= 5;
        await runner.startTransaction();
        try {
          const current = await runner.manager
            .getRepository(OrderEntity)
            .findOneOrFail({
              where: { id: order.id },
              lock: { mode: 'pessimistic_write' },
            });
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
          if (terminal && current.status === 'PENDING') {
            await this.reservations.release(runner.manager, order.id);
            await runner.manager.query(
              'UPDATE "order" SET status=\'CANCELLED\' WHERE id=$1',
              [order.id],
            );
          }
          await runner.manager.query(
            'UPDATE "order" SET processing_status=$2,last_attempt=$3 WHERE id=$1',
            [order.id, terminal ? 'FAILED' : 'RETRYING', event.attempt],
          );
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
    } finally {
      try {
        if (locked)
          await runner.query(
            'SELECT pg_advisory_unlock(hashtextextended($1,0))',
            [event.order_id],
          );
      } finally {
        await runner.release();
      }
    }
  }
}
