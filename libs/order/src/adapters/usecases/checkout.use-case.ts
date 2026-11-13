import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import {
  CheckoutInitiatedEvent,
  CheckoutInput,
  OrderStatus,
  ORDER_CHECKOUT_INITIATED,
} from '@app/contracts';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { StockRepository } from '@app/shop/inventory/stock.repository';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { OutboxRepository } from '../../repositories/outbox.repository';
import { createEventMeta } from '../../messaging/order-event';

const transientDatabaseCodes = new Set([
  '40001',
  '40P01',
  '53300',
  '55P03',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTransientDatabaseFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    const code = current.code;
    if (
      typeof code === 'string' &&
      (code.startsWith('08') ||
        code.startsWith('53') ||
        transientDatabaseCodes.has(code))
    )
      return true;
    current = current.driverError ?? current.cause;
  }
  return false;
}

export function checkoutHash(input: CheckoutInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        paymentType: input.paymentType,
        dueDate: input.dueDate,
        mainContact: input.mainContact,
        altContact: input.altContact ?? null,
        paymentMethod: input.paymentMethod,
        environment: input.environment,
        items: [...input.items]
          .sort((a, b) => a.productId.localeCompare(b.productId))
          .map(({ productId, quantity }) => ({ productId, quantity })),
      }),
    )
    .digest('hex');
}

@Injectable()
export class CheckoutUseCase {
  constructor(
    private readonly database: DataSource,
    private readonly stock: StockRepository,
    private readonly orders: OrderRepository,
    private readonly outbox: OutboxRepository,
    private readonly config: ConfigService,
    private readonly metrics: Metrics,
    private readonly spans: Spans,
  ) {}
  async execute(
    input: CheckoutInput,
    key: string | undefined,
    correlationId: string,
  ): Promise<{ orderId: string; status: OrderStatus.Pending }> {
    try {
      this.validateRequest(input, key);
      const requestHash = checkoutHash(input);
      const result = await this.spans.run('checkout.transaction', () =>
        this.createOrder(input, key, requestHash, correlationId),
      );
      this.metrics.checkout.inc({
        result: result.replay ? 'replayed' : 'accepted',
      });
      if (!result.replay)
        this.metrics.reservations.inc(
          { result: 'reserved' },
          input.items.length,
        );
      return { orderId: result.orderId, status: OrderStatus.Pending };
    } catch (error) {
      this.metrics.checkout.inc({ result: 'rejected' });
      if (error instanceof HttpException) throw error;
      if (isTransientDatabaseFailure(error))
        throw new ServiceUnavailableException(
          'Checkout temporarily unavailable; retry with the same idempotency key',
          { cause: error },
        );
      throw error;
    }
  }

  private validateRequest(
    input: CheckoutInput,
    key: string | undefined,
  ): asserts key is string {
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key must contain 1-128 visible ASCII characters',
      );
    if (
      new Set(input.items.map((item) => item.productId)).size !==
      input.items.length
    )
      throw new BadRequestException('Duplicate products are not allowed');
  }

  private createOrder(
    input: CheckoutInput,
    key: string,
    requestHash: string,
    correlationId: string,
  ): Promise<{ orderId: string; replay: boolean }> {
    return this.database.transaction(async (manager) => {
      const orderId = randomUUID();
      const inserted = await this.orders.insertPending(
        manager,
        orderId,
        input,
        key,
        requestHash,
        correlationId,
      );
      if (!inserted) {
        const existing = await this.orders.findByKey(manager, key);
        if (!existing) throw new Error('Order insert failed');
        if (existing.requestHash !== requestHash)
          throw new ConflictException(
            'Idempotency key already used with different content',
          );
        return { orderId: existing.id, replay: true };
      }

      const items = await this.stock.reserve(
        manager,
        orderId,
        input.items,
        this.config.getOrThrow<number>('RESERVATION_TTL_SECONDS'),
      );
      await this.orders.addItems(manager, orderId, items);
      await this.appendCheckoutEvent(manager, orderId, correlationId);
      return { orderId, replay: false };
    });
  }

  private appendCheckoutEvent(
    manager: EntityManager,
    orderId: string,
    correlationId: string,
  ): Promise<void> {
    const event: CheckoutInitiatedEvent = {
      data: {
        kind: ORDER_CHECKOUT_INITIATED,
        data: { order_id: orderId },
      },
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
}
