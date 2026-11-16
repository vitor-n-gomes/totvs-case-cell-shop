import { randomUUID } from 'node:crypto';
import {
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  parseOrderEvent,
} from '@app/order/messaging/order-events';
import { executionContext } from '@app/platform/observability/context';
import { Spans } from '@app/platform/observability/spans';
import { createEventMeta } from '@app/order/messaging/event.util';

const correlationId = randomUUID();
const orderId = randomUUID();

describe('order events (snake_case envelope)', () => {
  const meta = createEventMeta(correlationId);

  it('createEventMeta emits snake_case keys only', () => {
    expect(Object.keys(meta).sort()).toEqual([
      'correlation_id',
      'event_id',
      'occurred_at',
      'parent_span_id',
      'schema_version',
      'trace_id',
    ]);
    expect(meta.correlation_id).toBe(correlationId);
  });

  it.each([
    [
      ORDER_CHECKOUT_INITIATED,
      { data: { order_id: orderId }, meta: { ...meta, attempt: 1 } },
    ],
    [ORDER_RESERVATION_EXPIRED, { data: { order_id: orderId }, meta }],
  ])('accepts a valid %s event', (kind, rest) => {
    expect(parseOrderEvent({ kind, ...rest })).toEqual({ kind, ...rest });
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
        meta: { ...meta, correlationId },
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
    const info = jest.fn();
    const spans = new Spans({ info } as never);
    const parent = {
      correlation_id: correlationId,
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
    };
    const inner = await executionContext.run(parent, () =>
      spans.run('test', () => Promise.resolve(executionContext.getStore())),
    );
    expect(inner?.parent_span_id).toBe(parent.span_id);
    expect(inner?.span_id).not.toBe(parent.span_id);
    expect(info).toHaveBeenCalledWith(
      'trace.span',
      expect.objectContaining({
        span_id: inner?.span_id,
        parent_span_id: parent.span_id,
      }),
    );
  });
});
