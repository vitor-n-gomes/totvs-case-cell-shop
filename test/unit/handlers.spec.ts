import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { OrderActivatedHandler } from '@app/order/adapters/handlers/order-activated.handler';
import { ReservationExpiredHandler } from '@app/order/adapters/usecases/event-handlers/reservation-expired.handler';
import { CheckoutInitiatedHandler } from '@app/order/adapters/usecases/event-handlers/checkout-initiated.handler';
import { OrderEvent, OrderEventMeta } from '@app/order/domain/events';
import { OrderStatus } from '@app/contracts';

/**
 * Factory function to create a test OrderEvent
 */
const createOrderEvent = <T extends { orderId?: string }>(
  data: T,
  meta?: Partial<OrderEventMeta>,
): OrderEvent<T> => ({
  kind: 'test-event',
  data,
  meta: {
    correlationId: randomUUID(),
    traceId: randomUUID(),
    timestamp: Date.now(),
    ...meta,
  },
});

/**
 * Factory for generic event data
 */
const createEventData = (orderId: string = randomUUID()) => ({
  orderId,
});

describe('OrderActivatedHandler', () => {
  let handler: OrderActivatedHandler;
  let mockLogger: Partial<{
    info: jest.Mock;
    error: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
  }>;
  let mockOrderRepository: Partial<{
    findById: jest.Mock;
  }>;
  let mockMetrics: Partial<{
    reservations: { inc: jest.Mock };
  }>;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
    mockOrderRepository = {
      findById: jest.fn(),
    };
    mockMetrics = {
      reservations: { inc: jest.fn() },
    };

    handler = new OrderActivatedHandler(
      mockLogger as any,
      mockOrderRepository as any,
      mockMetrics as any,
    );
  });

  it('should handle order.activated event', async () => {
    const orderId = randomUUID();
    const correlationId = randomUUID();
    const event = createOrderEvent(
      { orderId },
      { correlationId },
    );

    const mockOrder = {
      id: orderId,
      status: OrderStatus.Pending,
      createdAt: new Date(),
    };
    (mockOrderRepository.findById as jest.Mock).mockResolvedValue(mockOrder);

    await handler.handle(event);

    expect(mockOrderRepository.findById).toHaveBeenCalledWith(orderId);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'order.activated.handler.processing',
      expect.objectContaining({
        orderId,
        correlationId,
      }),
    );
  });

  it('should log processing with correlation_id', async () => {
    const orderId = randomUUID();
    const correlationId = randomUUID();
    const event = createOrderEvent(
      { orderId },
      { correlationId },
    );

    const mockOrder = {
      id: orderId,
      status: OrderStatus.Pending,
    };
    (mockOrderRepository.findById as jest.Mock).mockResolvedValue(mockOrder);

    await handler.handle(event);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        correlationId,
      }),
    );
  });

  it('should increment metrics', async () => {
    const orderId = randomUUID();
    const event = createOrderEvent({ orderId });

    const mockOrder = {
      id: orderId,
      status: OrderStatus.Pending,
    };
    (mockOrderRepository.findById as jest.Mock).mockResolvedValue(mockOrder);

    await handler.handle(event);

    expect(mockMetrics.reservations!.inc).toHaveBeenCalledWith({
      result: 'activated',
    });
  });

  it('should handle missing order gracefully', async () => {
    const orderId = randomUUID();
    const correlationId = randomUUID();
    const event = createOrderEvent(
      { orderId },
      { correlationId },
    );

    (mockOrderRepository.findById as jest.Mock).mockResolvedValue(null);

    await handler.handle(event);

    expect(mockLogger.error).toHaveBeenCalledWith(
      'order.activated.handler.order_not_found',
      expect.objectContaining({
        orderId,
        correlationId,
      }),
    );
    expect(mockMetrics.reservations!.inc).not.toHaveBeenCalled();
  });

  it('should not throw on missing order', async () => {
    const orderId = randomUUID();
    const event = createOrderEvent({ orderId });

    (mockOrderRepository.findById as jest.Mock).mockResolvedValue(null);

    await expect(handler.handle(event)).resolves.not.toThrow();
  });
});

describe('ReservationExpiredHandler', () => {
  let handler: ReservationExpiredHandler;
  let mockDatabase: Partial<{
    transaction: jest.Mock;
  }>;
  let mockOrderRepository: Partial<{
    lock: jest.Mock;
    update: jest.Mock;
  }>;
  let mockReservationRepository: Partial<{
    hasExpired: jest.Mock;
    release: jest.Mock;
  }>;
  let mockMetrics: Partial<{
    reservations: { inc: jest.Mock };
  }>;

  beforeEach(() => {
    mockDatabase = {
      transaction: jest.fn(),
    };
    mockOrderRepository = {
      lock: jest.fn(),
      update: jest.fn(),
    };
    mockReservationRepository = {
      hasExpired: jest.fn(),
      release: jest.fn(),
    };
    mockMetrics = {
      reservations: { inc: jest.fn() },
    };

    handler = new ReservationExpiredHandler(
      mockDatabase as any,
      mockOrderRepository as any,
      mockReservationRepository as any,
      mockMetrics as any,
    );
  });

  it('should handle reservation.expired event', async () => {
    const orderId = randomUUID();
    const event: OrderEvent<{ data: { order_id: string } }> = {
      kind: 'ORDER_RESERVATION_EXPIRED',
      data: { data: { order_id: orderId } },
      meta: {
        correlationId: randomUUID(),
        traceId: randomUUID(),
        timestamp: Date.now(),
      },
    };

    const mockOrder = {
      id: orderId,
      status: OrderStatus.Pending,
    };

    (mockDatabase.transaction as jest.Mock).mockImplementation(
      (cb: Function) => cb({ getRepository: jest.fn() }),
    );
    (mockOrderRepository.lock as jest.Mock).mockResolvedValue(mockOrder);
    (mockReservationRepository.hasExpired as jest.Mock).mockResolvedValue(true);
    (mockReservationRepository.release as jest.Mock).mockResolvedValue(2);

    await handler.handle(event);

    expect(mockDatabase.transaction).toHaveBeenCalled();
  });

  it('should release reserved stock', async () => {
    const orderId = randomUUID();
    const event: OrderEvent<{ data: { order_id: string } }> = {
      kind: 'ORDER_RESERVATION_EXPIRED',
      data: { data: { order_id: orderId } },
      meta: {
        correlationId: randomUUID(),
        traceId: randomUUID(),
        timestamp: Date.now(),
      },
    };

    const mockOrder = {
      id: orderId,
      status: OrderStatus.Pending,
    };

    let capturedTransaction: any = null;
    (mockDatabase.transaction as jest.Mock).mockImplementation(
      (cb: Function) => {
        capturedTransaction = cb;
        return cb({ getRepository: jest.fn() });
      },
    );
    (mockOrderRepository.lock as jest.Mock).mockResolvedValue(mockOrder);
    (mockReservationRepository.hasExpired as jest.Mock).mockResolvedValue(true);
    (mockReservationRepository.release as jest.Mock).mockResolvedValue(3);

    await handler.handle(event);

    expect(mockReservationRepository.release).toHaveBeenCalled();
  });

  it('should cancel order', async () => {
    const orderId = randomUUID();
    const event: OrderEvent<{ data: { order_id: string } }> = {
      kind: 'ORDER_RESERVATION_EXPIRED',
      data: { data: { order_id: orderId } },
      meta: {
        correlationId: randomUUID(),
        traceId: randomUUID(),
        timestamp: Date.now(),
      },
    };

    const mockOrder = {
      id: orderId,
      status: OrderStatus.Pending,
    };

    (mockDatabase.transaction as jest.Mock).mockImplementation(
      (cb: Function) => cb({ getRepository: jest.fn() }),
    );
    (mockOrderRepository.lock as jest.Mock).mockResolvedValue(mockOrder);
    (mockReservationRepository.hasExpired as jest.Mock).mockResolvedValue(true);
    (mockReservationRepository.release as jest.Mock).mockResolvedValue(1);

    await handler.handle(event);

    expect(mockOrderRepository.update).toHaveBeenCalled();
  });

  it('should increment metrics on successful release', async () => {
    const orderId = randomUUID();
    const event: OrderEvent<{ data: { order_id: string } }> = {
      kind: 'ORDER_RESERVATION_EXPIRED',
      data: { data: { order_id: orderId } },
      meta: {
        correlationId: randomUUID(),
        traceId: randomUUID(),
        timestamp: Date.now(),
      },
    };

    const mockOrder = {
      id: orderId,
      status: OrderStatus.Pending,
    };

    (mockDatabase.transaction as jest.Mock).mockImplementation(
      (cb: Function) => {
        return cb({ getRepository: jest.fn() });
      },
    );
    (mockOrderRepository.lock as jest.Mock).mockResolvedValue(mockOrder);
    (mockReservationRepository.hasExpired as jest.Mock).mockResolvedValue(true);
    (mockReservationRepository.release as jest.Mock).mockResolvedValue(5);

    await handler.handle(event);

    expect(mockMetrics.reservations!.inc).toHaveBeenCalledWith(
      { result: 'expired' },
      5,
    );
  });

  it('should handle order already cancelled', async () => {
    const orderId = randomUUID();
    const event: OrderEvent<{ data: { order_id: string } }> = {
      kind: 'ORDER_RESERVATION_EXPIRED',
      data: { data: { order_id: orderId } },
      meta: {
        correlationId: randomUUID(),
        traceId: randomUUID(),
        timestamp: Date.now(),
      },
    };

    const mockOrder = {
      id: orderId,
      status: OrderStatus.Cancelled,
    };

    (mockDatabase.transaction as jest.Mock).mockImplementation(
      (cb: Function) => cb({ getRepository: jest.fn() }),
    );
    (mockOrderRepository.lock as jest.Mock).mockResolvedValue(mockOrder);
    (mockReservationRepository.hasExpired as jest.Mock).mockResolvedValue(true);
    (mockReservationRepository.release as jest.Mock).mockResolvedValue(0);

    await handler.handle(event);

    expect(mockMetrics.reservations!.inc).not.toHaveBeenCalled();
  });
});

describe('CheckoutInitiatedHandler', () => {
  let handler: CheckoutInitiatedHandler;
  let mockActivationUseCase: Partial<{
    execute: jest.Mock;
  }>;

  beforeEach(() => {
    mockActivationUseCase = {
      execute: jest.fn().mockResolvedValue(undefined),
    };

    handler = new CheckoutInitiatedHandler(mockActivationUseCase as any);
  });

  it('should invoke ActiveOrderUseCase', async () => {
    const orderId = randomUUID();
    const correlationId = randomUUID();
    const traceId = randomUUID();
    const parentSpanId = randomUUID();
    const eventId = randomUUID();
    const schemaVersion = 1;
    const occurredAt = new Date().toISOString();

    const event: any = {
      data: {
        data: {
          order_id: orderId,
        },
      },
      meta: {
        schema_version: schemaVersion,
        event_id: eventId,
        correlation_id: correlationId,
        occurred_at: occurredAt,
        attempt: 1,
        trace_id: traceId,
        parent_span_id: parentSpanId,
      },
    };

    await handler.execute(event);

    expect(mockActivationUseCase.execute).toHaveBeenCalled();
  });

  it('should convert event format', async () => {
    const orderId = randomUUID();
    const correlationId = randomUUID();
    const traceId = randomUUID();
    const eventId = randomUUID();

    const event: any = {
      data: {
        data: {
          order_id: orderId,
        },
      },
      meta: {
        schema_version: 1,
        event_id: eventId,
        correlation_id: correlationId,
        occurred_at: new Date().toISOString(),
        attempt: 1,
        trace_id: traceId,
        parent_span_id: randomUUID(),
      },
    };

    await handler.execute(event);

    expect(mockActivationUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: orderId,
        correlation_id: correlationId,
        trace_id: traceId,
        event_id: eventId,
      }),
    );
  });

  it('should handle errors', async () => {
    const orderId = randomUUID();
    const event: any = {
      data: {
        data: {
          order_id: orderId,
        },
      },
      meta: {
        schema_version: 1,
        event_id: randomUUID(),
        correlation_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        attempt: 1,
        trace_id: randomUUID(),
        parent_span_id: randomUUID(),
      },
    };

    const testError = new Error('Activation failed');
    (mockActivationUseCase.execute as jest.Mock).mockRejectedValue(testError);

    await expect(handler.execute(event)).rejects.toThrow('Activation failed');
  });

  it('should preserve event metadata', async () => {
    const orderId = randomUUID();
    const correlationId = randomUUID();
    const traceId = randomUUID();
    const parentSpanId = randomUUID();
    const eventId = randomUUID();
    const schemaVersion = 2;

    const event: any = {
      data: {
        data: {
          order_id: orderId,
        },
      },
      meta: {
        schema_version: schemaVersion,
        event_id: eventId,
        correlation_id: correlationId,
        occurred_at: '2024-01-01T12:00:00Z',
        attempt: 3,
        trace_id: traceId,
        parent_span_id: parentSpanId,
      },
    };

    await handler.execute(event);

    expect(mockActivationUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: schemaVersion,
        event_id: eventId,
        correlation_id: correlationId,
        attempt: 3,
        trace_id: traceId,
        parent_span_id: parentSpanId,
      }),
    );
  });
});
