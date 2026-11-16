import { executionContext, newTraceContext } from '../observability/context';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppLogger } from './app-logger';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(private readonly logger: AppLogger) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const supplied = z.uuid().safeParse(request.header('x-correlation-id'));
    const correlationId = supplied.success ? supplied.data : randomUUID();

    response.locals.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    const started = performance.now();
    const context = newTraceContext(correlationId);

    response.on('finish', () =>
      this.logger.info('http.request.completed', {
        ...context,
        method: request.method,
        path: request.path,
        status_code: response.statusCode,
        duration_ms: Math.round(performance.now() - started),
      }),
    );

    executionContext.run(context, next);
  }
}
