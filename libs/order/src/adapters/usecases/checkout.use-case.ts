import {
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { CheckoutInput } from '@app/order/domain/dto/create-order.dto';
import { OrderStatus } from '@app/order/domain/shared/types/order.type';
import {
  CheckoutInitiatedEvent,
  ORDER_CHECKOUT_INITIATED,
} from '@app/order/messaging/order-events';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { isTransientDatabaseFailure } from '@app/platform/database/transient-db-error';
import { executionContext } from '@app/platform/observability/context';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { StockRepository } from '@app/products/inventory/repositories/stock.repository';
import { createEventMeta } from '../../messaging/event.util';
import { OutboxRepository } from '../../repositories/outbox.repository';
import { CheckoutGuard } from './guards/checkout.guard';

export interface CheckoutResult {
  orderId: string;
  status: OrderStatus.Pending;
}

@Injectable()
export class CheckoutUseCase {
  constructor(
    private readonly database: DataSource,
    private readonly stock: StockRepository,
    private readonly orders: OrderRepository,
    private readonly outbox: OutboxRepository,
    private readonly guard: CheckoutGuard,
    private readonly config: ConfigService,
    private readonly metrics: Metrics,
    private readonly spans: Spans,
  ) {}

  async execute(
    input: CheckoutInput,
    idempotencyKey: string | undefined,
    correlationId = executionContext.getStore()?.correlation_id ?? randomUUID(),
  ): Promise<CheckoutResult> {
    try {

      this.guard.validate(input, idempotencyKey);
      const requestHash = this.guard.hashPayload(input);

      const { orderId, replay } = await this.spans.run(
        'checkout.transaction',
        () =>
          this.persistCheckout(
            input,
            idempotencyKey,
            requestHash,
            correlationId,
          ),
      );

      this.recordSuccessMetrics(replay, input.items.length);

      return { orderId, status: OrderStatus.Pending };

    } catch (error) {

      this.metrics.checkout.inc({ result: 'rejected' });

      throw this.mapExecutionError(error);

    }
  }

  private persistCheckout(
    input: CheckoutInput,
    idempotencyKey: string,
    requestHash: string,
    correlationId: string,
  ): Promise<{ orderId: string; replay: boolean }> {
    return this.database.transaction(async (manager) => {
      const orderId = randomUUID();

      const inserted = await this.orders.insertPending(
        manager,
        orderId,
        input,
        idempotencyKey,
        requestHash,
        correlationId,
      );

      if (!inserted) {

        return this.resolveIdempotentReplay(
          manager,
          idempotencyKey,
          requestHash,
        );

      }

      const ttlSeconds = this.config.getOrThrow<number>(
        'RESERVATION_TTL_SECONDS',
      );

      const reservedItems = await this.stock.reserve(
        manager,
        orderId,
        input.items,
        ttlSeconds,
      );

      await this.orders.addItems(manager, orderId, reservedItems);
      await this.appendCheckoutEvent(manager, orderId, correlationId);

      return { orderId, replay: false };
    });
  }

  private async resolveIdempotentReplay(
    manager: EntityManager,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ orderId: string; replay: true }> {
    const existing = await this.orders.findByKey(manager, idempotencyKey);

    if (!existing) {

      throw new Error('Order insert failed');

    }

    if (existing.requestHash !== requestHash) {

      throw new ConflictException(
        'Idempotency key already used with different content',
      );

    }

    return { orderId: existing.id, replay: true };
  }

  private appendCheckoutEvent(
    manager: EntityManager,
    orderId: string,
    correlationId: string,
  ): Promise<void> {
    const event: CheckoutInitiatedEvent = {
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: orderId },
      meta: { ...createEventMeta(correlationId), attempt: 1 },
    };

    return this.outbox.append(
      manager,
      orderId,
      this.config.getOrThrow<string>('CHECKOUT_TOPIC'),
      event,
      `${orderId}:attempt:1`,
    );
  }

  private recordSuccessMetrics(replay: boolean, itemCount: number): void {
    this.metrics.checkout.inc({ result: replay ? 'replayed' : 'accepted' });

    if (!replay) {

      this.metrics.reservations.inc({ result: 'reserved' }, itemCount);

    }
  }

  private mapExecutionError(error: unknown): unknown {
    if (error instanceof HttpException) {

      return error;

    }

    if (isTransientDatabaseFailure(error)) {

      return new ServiceUnavailableException(
        'Checkout temporarily unavailable; retry with the same idempotency key',
        { cause: error },
      );

    }

    return error;
  }
}
