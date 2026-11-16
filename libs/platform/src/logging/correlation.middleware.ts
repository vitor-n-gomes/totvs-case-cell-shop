import { executionContext, newTraceContext } from '../observability/context';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppLogger } from './app-logger';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(private readonly appLogger: AppLogger) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const correlationIdParseResult = z
      .uuid()
      .safeParse(request.header('X-Correlation-Id'));

    const correlationId = correlationIdParseResult.success
      ? correlationIdParseResult.data
      : randomUUID();

    response.locals.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    const requestStartedAt = performance.now();
    const traceContext = newTraceContext(correlationId);

    response.on('finish', () =>
      this.appLogger.info('http.request.completed', {
        ...traceContext,
        method: request.method,
        path: request.path,
        status_code: response.statusCode,
        duration_ms: Math.round(performance.now() - requestStartedAt),
      }),
    );

    executionContext.run(traceContext, next);
  }
}
