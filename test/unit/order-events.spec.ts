import { randomUUID } from 'node:crypto';
import {
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  parseOrderEvent,
} from '@app/orders/messaging/order-events';
import { executionContext } from '@app/platform/observability/context';
import { Spans } from '@app/platform/observability/spans';
import { createEventMeta } from '@app/orders/messaging/event.util';

const correlationId = randomUUID();
const orderId = randomUUID();

describe('order events (snake_case envelope)', () => {
  const eventMeta = createEventMeta(correlationId);

  it('createEventMeta emits snake_case keys only', () => {
    expect(Object.keys(eventMeta).sort()).toEqual([
      'correlation_id',
      'event_id',
      'occurred_at',
      'parent_span_id',
      'schema_version',
      'trace_id',
    ]);

    expect(eventMeta.correlation_id).toBe(correlationId);
  });

  it.each([
    [
      ORDER_CHECKOUT_INITIATED,
      { data: { order_id: orderId }, meta: { ...eventMeta, attempt: 1 } },
    ],
    [
      ORDER_RESERVATION_EXPIRED,
      { data: { order_id: orderId }, meta: eventMeta },
    ],
  ])('accepts a valid %s event', (kind, eventEnvelope) => {
    expect(parseOrderEvent({ kind, ...eventEnvelope })).toEqual({
      kind,
      ...eventEnvelope,
    });
  });

  it('rejects camelCase keys in data and meta', () => {
    expect(
      parseOrderEvent({
        kind: ORDER_RESERVATION_EXPIRED,
        data: { orderId },
      }),
    ).toBeNull();

    expect(
      parseOrderEvent({
        kind: ORDER_RESERVATION_EXPIRED,
        data: { order_id: orderId },
        meta: { ...eventMeta, correlationId },
      }),
    ).toBeNull();
  });

  it('requires meta with attempt for checkout events', () => {
    expect(
      parseOrderEvent({
        kind: ORDER_CHECKOUT_INITIATED,
        data: { order_id: orderId },
      }),
    ).toBeNull();
  });
});

describe('Spans', () => {
  it('propagates span_id and parent_span_id through the execution context', async () => {
    const logInfoMock = jest.fn();
    const spansService = new Spans({ info: logInfoMock } as never);

    const parentTraceContext = {
      correlation_id: correlationId,
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
    };

    const childTraceContext = await executionContext.run(
      parentTraceContext,
      () =>
        spansService.run('test', () =>
          Promise.resolve(executionContext.getStore()),
        ),
    );

    expect(childTraceContext?.parent_span_id).toBe(parentTraceContext.span_id);
    expect(childTraceContext?.span_id).not.toBe(parentTraceContext.span_id);

    expect(logInfoMock).toHaveBeenCalledWith(
      'trace.span',
      expect.objectContaining({
        span_id: childTraceContext?.span_id,
        parent_span_id: parentTraceContext.span_id,
      }),
    );
  });
});
