import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';
import { CheckoutUseCase } from '@app/order/adapters/usecases/checkout.use-case';
import { CheckoutGuard } from '@app/order/adapters/usecases/guards/checkout.guard';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { OutboxRepository } from '@app/order/repositories/outbox.repository';
import { OrderStatus } from '@app/order/domain/shared/types/order.type';
import { parseOrderEvent } from '@app/order/messaging/order-events';
import { StockRepository } from '@app/products/inventory/repositories/stock.repository';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';
import { checkoutPayload, loggerMock } from './support/fixtures';

describe('CheckoutUseCase', () => {
  async function setup() {
    const manager = {} as EntityManager;

    const dataSource = {
      transaction: jest.fn(
        (operation: (manager: EntityManager) => Promise<unknown>) =>
          operation(manager),
      ),
    };

    const orderRepository = {
      insertPending: jest.fn().mockResolvedValue(true),
      findByKey: jest.fn(),
      addItems: jest.fn().mockResolvedValue(undefined),
    };

    const reserved = [
      { productId: 'product', quantity: 2, netPrice: 1000, listPrice: 1500 },
    ];

    const stockRepository = { reserve: jest.fn().mockResolvedValue(reserved) };
    const outboxRepository = { append: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CheckoutUseCase,
        CheckoutGuard,
        Metrics,
        { provide: DataSource, useValue: dataSource },
        { provide: OrderRepository, useValue: orderRepository },
        { provide: StockRepository, useValue: stockRepository },
        { provide: OutboxRepository, useValue: outboxRepository },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            RESERVATION_TTL_SECONDS: 900,
            CHECKOUT_TOPIC: 'checkout',
          }),
        },
        {
          provide: Spans,
          useValue: new Spans(loggerMock() as unknown as AppLogger),
        },
      ],
    }).compile();

    const metrics = moduleRef.get(Metrics);

    return {
      service: moduleRef.get(CheckoutUseCase),
      guard: moduleRef.get(CheckoutGuard),
      dataSource,
      manager,
      orderRepository,
      stockRepository,
      outboxRepository,
      reserved,
      checkoutMetric: jest.spyOn(metrics.checkoutCounter, 'inc'),
      reservationMetric: jest.spyOn(
        metrics.reservationTransitionsCounter,
        'inc',
      ),
    };
  }

  it('persists stock, prices and a valid outbox event in the same transaction', async () => {
    const {
      service,
      manager,
      orderRepository,
      stockRepository,
      outboxRepository,
      reserved,
      checkoutMetric,
      reservationMetric,
    } = await setup();

    const payload = checkoutPayload();
    const correlationId = '00000000-0000-4000-8000-000000000001';
    const result = await service.execute(payload, 'key', correlationId);

    expect(result).toEqual({
      orderId: expect.any(String),
      status: OrderStatus.Pending,
    });

    expect(stockRepository.reserve).toHaveBeenCalledWith(
      manager,
      result.orderId,
      payload.items,
      900,
    );

    expect(orderRepository.addItems).toHaveBeenCalledWith(
      manager,
      result.orderId,
      reserved,
    );

    expect(outboxRepository.append).toHaveBeenCalledWith(
      manager,
      result.orderId,
      'checkout',
      expect.objectContaining({
        data: { order_id: result.orderId },
        meta: expect.objectContaining({
          correlation_id: correlationId,
          attempt: 1,
        }),
      }),
      `${result.orderId}:attempt:1`,
    );

    expect(
      parseOrderEvent(outboxRepository.append.mock.calls[0]![3]),
    ).not.toBeNull();

    expect(checkoutMetric).toHaveBeenCalledWith({ result: 'accepted' });
    expect(reservationMetric).toHaveBeenCalledWith({ result: 'reserved' }, 1);
  });

  it('replays the existing order without reserving stock or emitting another event', async () => {
    const {
      service,
      guard,
      orderRepository,
      stockRepository,
      outboxRepository,
      checkoutMetric,
      reservationMetric,
    } = await setup();

    const payload = checkoutPayload();

    orderRepository.insertPending.mockResolvedValue(false);

    orderRepository.findByKey.mockResolvedValue({
      id: 'existing-order',
      requestHash: guard.hashPayload(payload),
    });

    await expect(service.execute(payload, 'key')).resolves.toEqual({
      orderId: 'existing-order',
      status: OrderStatus.Pending,
    });

    expect(stockRepository.reserve).not.toHaveBeenCalled();
    expect(orderRepository.addItems).not.toHaveBeenCalled();
    expect(outboxRepository.append).not.toHaveBeenCalled();
    expect(checkoutMetric).toHaveBeenCalledWith({ result: 'replayed' });
    expect(reservationMetric).not.toHaveBeenCalled();
  });

  it('rejects reuse of a key with different content', async () => {
    const { service, orderRepository, stockRepository, outboxRepository } =
      await setup();

    orderRepository.insertPending.mockResolvedValue(false);

    orderRepository.findByKey.mockResolvedValue({
      id: 'existing',
      requestHash: 'different',
    });

    await expect(
      service.execute(checkoutPayload(), 'key'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(stockRepository.reserve).not.toHaveBeenCalled();
    expect(outboxRepository.append).not.toHaveBeenCalled();
  });

  it('surfaces an inconsistent idempotency record', async () => {
    const { service, orderRepository } = await setup();

    orderRepository.insertPending.mockResolvedValue(false);
    orderRepository.findByKey.mockResolvedValue(null);

    await expect(service.execute(checkoutPayload(), 'key')).rejects.toThrow(
      'Order insert failed',
    );
  });

  it('rejects invalid keys before starting a transaction', async () => {
    const { service, dataSource, checkoutMetric } = await setup();

    await expect(
      service.execute(checkoutPayload(), undefined),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(checkoutMetric).toHaveBeenCalledWith({ result: 'rejected' });
  });

  it.each(['40001', '40P01', '08006', '53300', 'ECONNREFUSED'])(
    'maps transient database error %s to a retryable HTTP response',
    async (code) => {
      const { service, dataSource, checkoutMetric } = await setup();

      const failure = Object.assign(new Error('database unavailable'), {
        driverError: { code },
      });

      dataSource.transaction.mockRejectedValue(failure);

      await expect(
        service.execute(checkoutPayload(), 'key'),
      ).rejects.toMatchObject({ status: 503, cause: failure });

      expect(checkoutMetric).toHaveBeenCalledWith({ result: 'rejected' });
    },
  );

  it('preserves existing HTTP exceptions', async () => {
    const { service, stockRepository, outboxRepository } = await setup();
    const failure = new ServiceUnavailableException('stock unavailable');

    stockRepository.reserve.mockRejectedValue(failure);

    await expect(service.execute(checkoutPayload(), 'key')).rejects.toBe(
      failure,
    );

    expect(outboxRepository.append).not.toHaveBeenCalled();
  });

  it('propagates an outbox write failure without reporting acceptance', async () => {
    const { service, outboxRepository, checkoutMetric, reservationMetric } =
      await setup();

    const failure = new Error('outbox write failed');

    outboxRepository.append.mockRejectedValue(failure);

    await expect(service.execute(checkoutPayload(), 'key')).rejects.toBe(
      failure,
    );

    expect(checkoutMetric).toHaveBeenCalledTimes(1);
    expect(checkoutMetric).toHaveBeenCalledWith({ result: 'rejected' });
    expect(reservationMetric).not.toHaveBeenCalled();
  });
});
