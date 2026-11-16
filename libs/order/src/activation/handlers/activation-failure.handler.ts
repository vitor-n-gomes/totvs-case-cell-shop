import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { QueryRunner } from 'typeorm';
import {
  CheckoutInitiatedEvent,
  ORDER_CHECKOUT_INITIATED,
} from '@app/order/messaging/order-events';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { OrderEntity } from '@app/order/domain/entities';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { OrderRepository } from '../../repositories/order.repository';
import { OutboxRepository } from '../../repositories/outbox.repository';
import { IdempotencyLogRepository } from '../../repositories/idempotency-log.repository';
import { PermanentActivationError } from '../guards/activation-errors';
import { ActivationContext } from '../steps/activation-step';

const MAX_ATTEMPTS = 5;

@Injectable()
export class ActivationFailureHandler {
  constructor(
    private readonly orders: OrderRepository,
    private readonly journal: IdempotencyLogRepository,
    private readonly outbox: OutboxRepository,
    private readonly reservations: ReservationRepository,
    private readonly config: ConfigService,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async handle(
    runner: QueryRunner,
    order: OrderEntity,
    context: ActivationContext,
    error: unknown,
  ): Promise<void> {
    const { attempt } = context.event.meta;

    const terminal =
      error instanceof PermanentActivationError || attempt >= MAX_ATTEMPTS;

    await this.inTransaction(runner, () =>
      this.recordFailure(runner, order, context, error, terminal),
    );

    this.metrics.processing.inc({ result: terminal ? 'dlq' : 'retry' });

    this.logger.warn('order.activation.failed', {
      order_id: order.id,
      step: context.currentStep,
      attempt,
      terminal,
    });
  }

  private async recordFailure(
    runner: QueryRunner,
    order: OrderEntity,
    context: ActivationContext,
    error: unknown,
    terminal: boolean,
  ): Promise<void> {
    const { manager } = runner;
    const { event } = context;
    const { attempt } = event.meta;
    const current = await this.orders.lockOrFail(manager, order.id);

    const reference = {
      error_type: error instanceof Error ? error.name : 'UnknownError',
      attempt,
      event_id: event.meta.event_id,
    };

    await this.journal.record(
      manager,
      order.id,
      context.currentStep,
      false,
      reference,
      terminal ? 'Failed; dead letter scheduled' : 'Failed; retry scheduled',
    );

    if (terminal && current.status === OrderStatus.Pending) {
      await this.reservations.release(manager, order.id);

      await this.orders.update(manager, order.id, {
        status: OrderStatus.Cancelled,
      });
    }

    await this.orders.update(manager, order.id, {
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

    // Terminal failures dead-letter the same checkout event; failure details live in the journal.
    const nextEvent: CheckoutInitiatedEvent = {
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: order.id },
      meta: nextMeta,
    };

    await this.outbox.append(
      manager,
      order.id,
      terminal ? `${topic}.dlq` : topic,
      nextEvent,
      `${order.id}:${terminal ? 'dlq' : 'attempt'}:${nextMeta.attempt}`,
      terminal ? 0 : 2 ** (attempt - 1),
    );
  }

  private async inTransaction(
    runner: QueryRunner,
    work: () => Promise<void>,
  ): Promise<void> {
    await runner.startTransaction();

    try {
      await work();
      await runner.commitTransaction();
    } catch (failure) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      throw failure;
    }
  }
}
