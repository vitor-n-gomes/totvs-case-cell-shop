import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  correlation_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  order_id?: string;
}
export const executionContext = new AsyncLocalStorage<TraceContext>();
export const newTraceContext = (correlationId: string): TraceContext => ({
  correlation_id: correlationId,
  trace_id: randomBytes(16).toString('hex'),
  span_id: randomBytes(8).toString('hex'),
});
