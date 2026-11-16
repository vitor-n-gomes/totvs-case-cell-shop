import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppLogger } from '../logging/app-logger';
import { executionContext } from './context';

/** Local tracing simulation: span logs preserve causality but are not an OTel exporter. */
@Injectable()
export class Spans {
  constructor(private readonly logger: AppLogger) {}

  async run<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const parent = executionContext.getStore();
    const spanId = randomBytes(8).toString('hex');
    const started = performance.now();

    const invoke = async () => {
      let outcome = 'success';

      try {
        return await operation();
      } catch (error) {
        outcome = 'error';

        throw error;
      } finally {
        this.logger.info('trace.span', {
          name,
          span_id: spanId,
          parent_span_id: parent?.span_id,
          duration_ms: performance.now() - started,
          outcome,
        });
      }
    };

    return parent
      ? executionContext.run(
          { ...parent, span_id: spanId, parent_span_id: parent.span_id },
          invoke,
        )
      : invoke();
  }
}
