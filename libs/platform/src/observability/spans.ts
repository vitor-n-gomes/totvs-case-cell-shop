import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppLogger } from '../logging/app-logger';
import { executionContext } from './context';

/** Local tracing simulation: span logs preserve causality but are not an OTel exporter. */
@Injectable()
export class Spans {
  constructor(private readonly appLogger: AppLogger) {}

  async run<T>(spanName: string, operation: () => Promise<T>): Promise<T> {
    const parentTraceContext = executionContext.getStore();
    const spanId = randomBytes(8).toString('hex');
    const spanStartedAt = performance.now();

    const runOperation = async () => {
      let spanOutcome = 'success';

      try {

        return await operation();

      } catch (error) {

        spanOutcome = 'error';

        throw error;

      } finally {

        this.appLogger.info('trace.span', {
          name: spanName,
          span_id: spanId,
          parent_span_id: parentTraceContext?.span_id,
          duration_ms: performance.now() - spanStartedAt,
          outcome: spanOutcome,
        });

      }
    };

    return parentTraceContext
      ? executionContext.run(
          {
            ...parentTraceContext,
            span_id: spanId,
            parent_span_id: parentTraceContext.span_id,
          },
          runOperation,
        )
      : runOperation();
  }
}
