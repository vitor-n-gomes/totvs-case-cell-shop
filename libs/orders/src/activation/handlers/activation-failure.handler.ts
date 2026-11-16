import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { QueryRunner } from 'typeorm';
import {
  CheckoutInitiatedEvent,
  ORDER_CHECKOUT_INITIATED,
} from '../../messaging/order-events';
import {
  OrderStatus,
  ProcessingStatus,
} from '../../domain/shared/types/order.type';
import { OrderEntity } from '../../domain/entities';
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
    private readonly orderRepository: OrderRepository,
    private readonly idempotencyLogRepository: IdempotencyLogRepository,
    private readonly outboxRepository: OutboxRepository,
    private readonly reservationRepository: ReservationRepository,
    private readonly configService: ConfigService,
    private readonly metricsService: Metrics,
    private readonly appLogger: AppLogger,
  ) {}

  async handle(
    queryRunner: QueryRunner,
    order: OrderEntity,
    activationContext: ActivationContext,
    error: unknown,
  ): Promise<void> {
    const { attempt } = activationContext.event.meta;

    const isTerminalFailure =
      error instanceof PermanentActivationError || attempt >= MAX_ATTEMPTS;

    await this.inTransaction(queryRunner, () =>
      this.recordFailure(
        queryRunner,
        order,
        activationContext,
        error,
        isTerminalFailure,
      ),
    );

    this.metricsService.processingCounter.inc({
      result: isTerminalFailure ? 'dlq' : 'retry',
    });

    this.appLogger.warn('order.activation.failed', {
      order_id: order.id,
      step: activationContext.currentStep,
      attempt,
      terminal: isTerminalFailure,
    });
  }

  private async recordFailure(
    queryRunner: QueryRunner,
    order: OrderEntity,
    activationContext: ActivationContext,
    error: unknown,
    isTerminalFailure: boolean,
  ): Promise<void> {
    const { manager: entityManager } = queryRunner;
    const { event } = activationContext;
    const { attempt } = event.meta;

    const lockedOrder = await this.orderRepository.lockOrFail(
      entityManager,
      order.id,
    );

    const failureReference = {
      error_type: error instanceof Error ? error.name : 'UnknownError',
      attempt,
      event_id: event.meta.event_id,
    };

    await this.idempotencyLogRepository.record(
      entityManager,
      order.id,
      activationContext.currentStep,
      false,
      failureReference,
      isTerminalFailure
        ? 'Failed; dead letter scheduled'
        : 'Failed; retry scheduled',
    );

    if (isTerminalFailure && lockedOrder.status === OrderStatus.Pending) {

      await this.reservationRepository.release(entityManager, order.id);

      await this.orderRepository.update(entityManager, order.id, {
        status: OrderStatus.Cancelled,
      });

    }

    await this.orderRepository.update(entityManager, order.id, {
      processingStatus: isTerminalFailure
        ? ProcessingStatus.Failed
        : ProcessingStatus.Retrying,
      lastAttempt: attempt,
    });

    const checkoutTopic =
      this.configService.getOrThrow<string>('CHECKOUT_TOPIC');

    const nextEventMeta = {
      ...event.meta,
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      attempt: isTerminalFailure ? attempt : attempt + 1,
    };

    // Terminal failures dead-letter the same checkout event; failure details live in the journal.
    const nextEvent: CheckoutInitiatedEvent = {
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: order.id },
      meta: nextEventMeta,
    };

    await this.outboxRepository.append(
      entityManager,
      order.id,
      isTerminalFailure ? `${checkoutTopic}.dlq` : checkoutTopic,
      nextEvent,
      `${order.id}:${isTerminalFailure ? 'dlq' : 'attempt'}:${nextEventMeta.attempt}`,
      isTerminalFailure ? 0 : 2 ** (attempt - 1),
    );
  }

  private async inTransaction(
    queryRunner: QueryRunner,
    transactionOperation: () => Promise<void>,
  ): Promise<void> {
    await queryRunner.startTransaction();

    try {

      await transactionOperation();
      await queryRunner.commitTransaction();

    } catch (transactionError) {

      if (queryRunner.isTransactionActive) {

        await queryRunner.rollbackTransaction();

      }

      throw transactionError;

    }
  }
}
