import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
} from '@app/contracts';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Metrics } from '@app/platform/observability/metrics';
import { ProcessOrderEventUseCase, EventSource } from '@app/order/adapters/usecases/process-order-event.use-case';
import { OrderMessaging } from '@app/order/adapters/order.messaging';
import { CheckoutInitiatedHandler } from '@app/order/adapters/usecases/event-handlers/checkout-initiated.handler';
import { ReservationExpiredHandler } from '@app/order/adapters/usecases/event-handlers/reservation-expired.handler';

const createCheckoutInitiatedEvent = (orderId: string = randomUUID()) => ({
  data: {
    kind: ORDER_CHECKOUT_INITIATED,
    data: { order_id: orderId },
  },
  meta: {
    schema_version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    trace_id: randomUUID().replace(/-/g, '').substring(0, 32),
    parent_span_id: randomUUID().replace(/-/g, '').substring(0, 16),
    attempt: 1,
  },
});

const createReservationExpiredEvent = (orderId: string = randomUUID()) => ({
  data: {
    kind: ORDER_RESERVATION_EXPIRED,
    data: { order_id: orderId },
  },
  meta: {
    schema_version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    trace_id: randomUUID().replace(/-/g, '').substring(0, 32),
    parent_span_id: randomUUID().replace(/-/g, '').substring(0, 16),
  },
});

const createEventSource = (
  topic: string = 'order.checkout.initiated',
  partition: number = 0,
  offset: string = '100',
): EventSource => ({
  topic,
  partition,
  offset,
});

describe('ProcessOrderEventUseCase - Event Dispatch Pattern', () => {
  let useCase: ProcessOrderEventUseCase;
  let mockCheckoutInitiated: jest.Mocked<Partial<CheckoutInitiatedHandler>>;
  let mockReservationExpired: jest.Mocked<Partial<ReservationExpiredHandler>>;
  let mockMessaging: jest.Mocked<Partial<OrderMessaging>>;
  let mockConfig: jest.Mocked<Partial<ConfigService>>;
  let mockLogger: jest.Mocked<Partial<AppLogger>>;
  let mockMetrics: jest.Mocked<Partial<Metrics>>;

  beforeEach(() => {
    mockCheckoutInitiated = {
      execute: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockReservationExpired = {
      handle: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockMessaging = {
      publish: jest.fn().mockResolvedValue(undefined),
      ensureConnected: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockConfig = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'CHECKOUT_TOPIC') return 'order.checkout.initiated';
        throw new Error(`Unknown config key: ${key}`);
      }),
    } as any;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

    mockMetrics = {
      processing: {
        inc: jest.fn(),
      },
    } as any;

    useCase = new ProcessOrderEventUseCase(
      mockCheckoutInitiated as any,
      mockReservationExpired as any,
      mockMessaging as any,
      mockConfig as any,
      mockLogger as any,
      mockMetrics as any,
    );
  });

  describe('Event Dispatch - Switch Case Pattern', () => {
    it('should dispatch ORDER_CHECKOUT_INITIATED to CheckoutInitiatedHandler', async () => {
      const orderId = randomUUID();
      const payload = createCheckoutInitiatedEvent(orderId);
      const source = createEventSource();

      await useCase.handle(payload, source);

      expect(mockCheckoutInitiated.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: ORDER_CHECKOUT_INITIATED,
          }),
        }),
      );
      expect(mockReservationExpired.handle).not.toHaveBeenCalled();
    });

    it('should dispatch ORDER_RESERVATION_EXPIRED to ReservationExpiredHandler', async () => {
      const orderId = randomUUID();
      const payload = createReservationExpiredEvent(orderId);
      const source = createEventSource();

      await useCase.handle(payload, source);

      expect(mockReservationExpired.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: ORDER_RESERVATION_EXPIRED,
          }),
        }),
      );
      expect(mockCheckoutInitiated.execute).not.toHaveBeenCalled();
    });

    it('should reject unknown event kinds with error', async () => {
      const orderId = randomUUID();
      const payload = {
        data: {
          kind: 'UNKNOWN_EVENT_KIND',
          data: { order_id: orderId },
        },
        meta: {
          schema_version: 1,
          event_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          correlation_id: randomUUID(),
          trace_id: randomUUID().replace(/-/g, '').substring(0, 32),
          parent_span_id: randomUUID().replace(/-/g, '').substring(0, 16),
        },
      };
      const source = createEventSource();

      // This should fail normalization since UNKNOWN_EVENT_KIND doesn't match any schema
      await useCase.handle(payload, source);

      // Should route to DLQ
      expect(mockMessaging.publish).toHaveBeenCalledWith(
        'order.checkout.initiated.dlq',
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should handle handler execution errors gracefully', async () => {
      const orderId = randomUUID();
      const payload = createCheckoutInitiatedEvent(orderId);
      const source = createEventSource();
      const testError = new Error('Handler execution failed');

      mockCheckoutInitiated.execute.mockRejectedValueOnce(testError);

      await useCase.handle(payload, source);

      // Should route to DLQ on handler error
      expect(mockMessaging.publish).toHaveBeenCalledWith(
        'order.checkout.initiated.dlq',
        orderId,
        expect.objectContaining({
          reason: 'Handler execution failed',
          order_id: orderId,
        }),
      );
    });
  });

  describe('Event Validation', () => {
    it('should reject invalid events and route to DLQ', async () => {
      const invalidPayload = { invalid: 'data' };
      const source = createEventSource();

      await useCase.handle(invalidPayload, source);

      expect(mockCheckoutInitiated.execute).not.toHaveBeenCalled();
      expect(mockReservationExpired.handle).not.toHaveBeenCalled();
      expect(mockMessaging.publish).toHaveBeenCalledWith(
        'order.checkout.initiated.dlq',
        'order.checkout.initiated:0:100',
        expect.objectContaining({
          reason: 'Invalid event',
        }),
      );
    });

    it('should reject events missing order_id and route to DLQ', async () => {
      const payload = {
        data: {
          kind: ORDER_CHECKOUT_INITIATED,
          data: { /* no order_id */ },
        },
        meta: {
          schema_version: 1,
          event_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          correlation_id: randomUUID(),
          trace_id: randomUUID().replace(/-/g, '').substring(0, 32),
          parent_span_id: randomUUID().replace(/-/g, '').substring(0, 16),
          attempt: 1,
        },
      };
      const source = createEventSource();

      await useCase.handle(payload, source);

      expect(mockMessaging.publish).toHaveBeenCalled();
      const callArgs = mockMessaging.publish.mock.calls[0];
      expect(callArgs[0]).toBe('order.checkout.initiated.dlq');
    });
  });

  describe('Observability - Logging & Metrics', () => {
    it('should log received events with proper context', async () => {
      const orderId = randomUUID();
      const payload = createCheckoutInitiatedEvent(orderId);
      const source = createEventSource();

      await useCase.handle(payload, source);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'checkout.event.received',
        expect.objectContaining({
          event_id: expect.any(String),
          kind: ORDER_CHECKOUT_INITIATED,
        }),
      );
    });

    it('should record DLQ metrics on invalid events', async () => {
      const source = createEventSource();

      await useCase.handle({ invalid: 'data' }, source);

      expect(mockMetrics.processing.inc).toHaveBeenCalledWith({
        result: 'invalid_dlq',
      });
    });
  });

  describe('Dead Letter Queue (DLQ) Handling', () => {
    it('should publish to DLQ with proper structure on invalid events', async () => {
      const source = createEventSource('my.topic', 5, '999');

      await useCase.handle(null, source);

      expect(mockMessaging.publish).toHaveBeenCalledWith(
        'order.checkout.initiated.dlq',
        'my.topic:5:999',
        expect.objectContaining({
          source_topic: 'my.topic',
          partition: 5,
          offset: '999',
          reason: expect.any(String),
        }),
      );
    });

    it('should include order_id in DLQ message when available', async () => {
      const orderId = randomUUID();
      const payload = createCheckoutInitiatedEvent(orderId);
      const source = createEventSource();

      mockCheckoutInitiated.execute.mockRejectedValueOnce(new Error('Test error'));

      await useCase.handle(payload, source);

      expect(mockMessaging.publish).toHaveBeenCalledWith(
        'order.checkout.initiated.dlq',
        orderId,
        expect.objectContaining({
          order_id: orderId,
        }),
      );
    });
  });

  describe('Integration Scenarios', () => {
    it('should process a complete ORDER_CHECKOUT_INITIATED event flow', async () => {
      const orderId = randomUUID();
      const payload = createCheckoutInitiatedEvent(orderId);
      const source = createEventSource();

      await useCase.handle(payload, source);

      expect(mockCheckoutInitiated.execute).toHaveBeenCalled();
      expect(mockMessaging.publish).not.toHaveBeenCalled();
    });

    it('should process a complete ORDER_RESERVATION_EXPIRED event flow', async () => {
      const orderId = randomUUID();
      const payload = createReservationExpiredEvent(orderId);
      const source = createEventSource();

      await useCase.handle(payload, source);

      expect(mockReservationExpired.handle).toHaveBeenCalled();
      expect(mockMessaging.publish).not.toHaveBeenCalled();
    });

    it('should handle multiple sequential events with different kinds', async () => {
      const orderId1 = randomUUID();
      const orderId2 = randomUUID();
      const source = createEventSource();

      const event1 = createCheckoutInitiatedEvent(orderId1);
      await useCase.handle(event1, source);

      const event2 = createReservationExpiredEvent(orderId2);
      await useCase.handle(event2, source);

      expect(mockCheckoutInitiated.execute).toHaveBeenCalledTimes(1);
      expect(mockReservationExpired.handle).toHaveBeenCalledTimes(1);
    });

    it('should isolate handler failures - one handler error does not affect others', async () => {
      const orderId1 = randomUUID();
      const orderId2 = randomUUID();
      const source = createEventSource();

      const event1 = createCheckoutInitiatedEvent(orderId1);
      mockCheckoutInitiated.execute.mockRejectedValueOnce(new Error('Handler 1 failed'));

      await useCase.handle(event1, source);

      // Reset and prepare for second event
      mockCheckoutInitiated.execute.mockResolvedValueOnce(undefined);

      const event2 = createCheckoutInitiatedEvent(orderId2);
      await useCase.handle(event2, source);

      expect(mockCheckoutInitiated.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Handling - Non-Error Exceptions', () => {
    it('should handle non-Error exceptions in handlers', async () => {
      const orderId = randomUUID();
      const payload = createCheckoutInitiatedEvent(orderId);
      const source = createEventSource();

      mockCheckoutInitiated.execute.mockRejectedValueOnce('String error');

      await useCase.handle(payload, source);

      expect(mockMessaging.publish).toHaveBeenCalledWith(
        'order.checkout.initiated.dlq',
        orderId,
        expect.objectContaining({
          reason: 'Unknown error',
        }),
      );
    });
  });
});
