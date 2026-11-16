import { randomUUID } from 'node:crypto';
import { EntityManager, QueryRunner } from 'typeorm';
import { OrderEntity } from '@app/orders/domain/entities/order.entity';
import { CheckoutDto } from '@app/orders/domain/dto/create-order.dto';
import {
  Environment,
  OrderStatus,
  PaymentType,
  ProcessingStatus,
} from '@app/orders/domain/shared/types/order.type';
import { createEventMeta } from '@app/orders/messaging/event.util';
import {
  CheckoutInitiatedEvent,
  ORDER_CHECKOUT_INITIATED,
} from '@app/orders/messaging/order-events';
import { StepName } from '@app/orders/activation/constants/step-names';
import { ActivationContext } from '@app/orders/activation/steps/activation-step';

export function checkoutPayload(): CheckoutDto {
  return {
    paymentType: PaymentType.PrePaid,
    dueDate: '2026-11-16',
    mainContact: 'customer@example.test',
    paymentMethod: 'PIX',
    environment: Environment.Local,
    items: [{ productId: randomUUID(), quantity: 2 }],
  };
}

export function orderFixture(
  overrides: Partial<OrderEntity> = {},
): OrderEntity {
  return Object.assign(
    new OrderEntity(),
    checkoutPayload(),
    {
      id: randomUUID(),
      status: OrderStatus.Pending,
      processingStatus: ProcessingStatus.Pending,
      lastAttempt: 0,
      idempotencyKey: 'checkout-key',
      requestHash: 'request-hash',
      correlationId: randomUUID(),
      createdAt: new Date('2026-11-16T12:00:00.000Z'),
      updatedAt: new Date('2026-11-16T12:00:00.000Z'),
    },
    overrides,
  );
}

export function checkoutEvent(
  orderId: string = randomUUID(),
  attempt = 1,
): CheckoutInitiatedEvent {
  return {
    kind: ORDER_CHECKOUT_INITIATED,
    data: { order_id: orderId },
    meta: { ...createEventMeta(randomUUID()), attempt },
  };
}

export function transactionRunner() {
  const runner = {
    manager: {} as EntityManager,
    isTransactionActive: false,
    startTransaction: jest.fn(async () => {
      runner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
  };

  return { runner, queryRunner: runner as unknown as QueryRunner };
}

export function activationFixture() {
  const { runner, queryRunner } = transactionRunner();
  const order = orderFixture();

  const context: ActivationContext = {
    order,
    event: checkoutEvent(order.id),
    correlationId: order.correlationId,
    entityManager: runner.manager,
    currentStep: StepName.ConsumeStockReservationStep,
  };

  return { runner, queryRunner, order, context };
}

export function loggerMock() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}
