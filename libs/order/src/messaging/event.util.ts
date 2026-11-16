import { randomUUID } from 'node:crypto';
import { EventMeta } from '@app/order/messaging/order-events';
import {
  executionContext,
  newTraceContext,
} from '@app/platform/observability/context';

export function createEventMeta(correlationId: string): EventMeta {
  const context = executionContext.getStore() ?? newTraceContext(correlationId);

  return {
    schema_version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    correlation_id: correlationId,
    trace_id: context.trace_id,
    parent_span_id: context.span_id,
  };
}
