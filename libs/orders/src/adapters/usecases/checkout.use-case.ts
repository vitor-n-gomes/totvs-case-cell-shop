import {
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  CheckoutCommand,
  CheckoutDto,
} from '../../domain/dto/create-order.dto';
import { OrderStatus } from '../../domain/shared/types/order.type';
import {
  CheckoutInitiatedEvent,
  ORDER_CHECKOUT_INITIATED,
} from '../../messaging/order-events';
import { OrderRepository } from '../../repositories/order.repository';
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
    private readonly dataSource: DataSource,
    private readonly stockRepository: StockRepository,
    private readonly orderRepository: OrderRepository,
    private readonly outboxRepository: OutboxRepository,
    private readonly checkoutGuard: CheckoutGuard,
    private readonly configService: ConfigService,
    private readonly metricsService: Metrics,
    private readonly spansService: Spans,
  ) {}

  async execute(
    checkoutDto: CheckoutDto,
    idempotencyKey: string | undefined,
    environment: string | undefined,
    correlationId = executionContext.getStore()?.correlation_id ?? randomUUID(),
  ): Promise<CheckoutResult> {
    try {

      this.checkoutGuard.validate(checkoutDto, idempotencyKey);

      const checkoutCommand: CheckoutCommand = {
        ...checkoutDto,
        environment: this.checkoutGuard.parseEnvironment(environment),
      };

      const requestHash = this.checkoutGuard.hashPayload(checkoutCommand);

      const { orderId, replay: isIdempotentReplay } =
        await this.spansService.run('checkout.transaction', () =>
          this.persistCheckout(
            checkoutCommand,
            idempotencyKey,
            requestHash,
            correlationId,
          ),
        );

      this.recordSuccessMetrics(isIdempotentReplay, checkoutDto.items.length);

      return { orderId, status: OrderStatus.Pending };

    } catch (error) {

      this.metricsService.checkoutCounter.inc({ result: 'rejected' });

      throw this.mapExecutionError(error);

    }
  }

  private persistCheckout(
    checkoutDto: CheckoutCommand,
    idempotencyKey: string,
    requestHash: string,
    correlationId: string,
  ): Promise<{ orderId: string; replay: boolean }> {
    return this.dataSource.transaction(async (entityManager) => {
      const orderId = randomUUID();

      const wasOrderInserted = await this.orderRepository.insertPending(
        entityManager,
        orderId,
        checkoutDto,
        idempotencyKey,
        requestHash,
        correlationId,
      );

      if (!wasOrderInserted) {

        return this.resolveIdempotentReplay(
          entityManager,
          idempotencyKey,
          requestHash,
        );

      }

      const reservationTtlSeconds = this.configService.getOrThrow<number>(
        'RESERVATION_TTL_SECONDS',
      );

      const reservedItems = await this.stockRepository.reserve(
        entityManager,
        orderId,
        checkoutDto.items,
        reservationTtlSeconds,
      );

      await this.orderRepository.addItems(
        entityManager,
        orderId,
        reservedItems,
      );

      await this.appendCheckoutEvent(entityManager, orderId, correlationId);

      return { orderId, replay: false };
    });
  }

  private async resolveIdempotentReplay(
    entityManager: EntityManager,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ orderId: string; replay: true }> {
    const existingOrder = await this.orderRepository.findByKey(
      entityManager,
      idempotencyKey,
    );

    if (!existingOrder) {

      throw new Error('Order insert failed');

    }

    if (existingOrder.requestHash !== requestHash) {

      throw new ConflictException(
        'Idempotency key already used with different content',
      );

    }

    return { orderId: existingOrder.id, replay: true };
  }

  private appendCheckoutEvent(
    entityManager: EntityManager,
    orderId: string,
    correlationId: string,
  ): Promise<void> {
    const checkoutInitiatedEvent: CheckoutInitiatedEvent = {
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: orderId },
      meta: { ...createEventMeta(correlationId), attempt: 1 },
    };

    return this.outboxRepository.append(
      entityManager,
      orderId,
      this.configService.getOrThrow<string>('CHECKOUT_TOPIC'),
      checkoutInitiatedEvent,
      `${orderId}:attempt:1`,
    );
  }

  private recordSuccessMetrics(
    isIdempotentReplay: boolean,
    itemCount: number,
  ): void {
    this.metricsService.checkoutCounter.inc({
      result: isIdempotentReplay ? 'replayed' : 'accepted',
    });

    if (!isIdempotentReplay) {

      this.metricsService.reservationTransitionsCounter.inc(
        { result: 'reserved' },
        itemCount,
      );

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
