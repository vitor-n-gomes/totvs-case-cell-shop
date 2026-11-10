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
    response.on('finish', () =>
      this.logger.info('http.request.completed', {
        correlationId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      }),
    );
    next();
  }
}
