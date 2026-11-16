import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { AppLogger } from '../logging/app-logger';
import { Metrics } from './metrics';

export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 6) {

    return '[truncated]';

  }

  if (Array.isArray(value)) {

    return value
      .slice(0, 100)
      .map((entry) => sanitizePayload(entry, depth + 1));

  }

  if (value !== null && typeof value === 'object') {

    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, entry]) => [
          key,
          /contact|password|secret|token|authorization|cookie|card|email/i.test(
            key,
          )
            ? '[redacted]'
            : sanitizePayload(entry, depth + 1),
        ]),
    );

  }

  return typeof value === 'string' ? value.slice(0, 500) : (value ?? null);
}

interface AuditEntry {
  url: string;
  method: string;
  payload: unknown;
  correlationId: string;
}
@Injectable()
export class RequestAuditRepository implements BeforeApplicationShutdown {
  private readonly auditQueue: AuditEntry[] = [];
  private drainPromise?: Promise<void>;
  private isClosing = false;
  constructor(
    private readonly dataSource: DataSource,
    private readonly metricsService: Metrics,
    private readonly appLogger: AppLogger,
  ) {}

  enqueue(auditEntry: AuditEntry): void {
    if (this.isClosing || this.auditQueue.length >= 1000) {

      this.metricsService.requestAuditCounter.inc({ result: 'dropped' });

      return;

    }

    this.auditQueue.push(auditEntry);
    this.startDrain();
  }

  private startDrain(): void {
    if (!this.drainPromise) {

      this.drainPromise = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.drain())
        .finally(() => {
          this.drainPromise = undefined;

          if (this.auditQueue.length) {

            this.startDrain();

          }
        });

    }
  }

  private async drain(): Promise<void> {
    while (this.auditQueue.length) {

      const auditEntry = this.auditQueue.shift()!;

      try {

        await this.dataSource.query(
          'INSERT INTO request_log (id,url,method,payload,correlation_id) VALUES ($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            auditEntry.url,
            auditEntry.method,
            JSON.stringify(auditEntry.payload),
            auditEntry.correlationId,
          ],
        );

        this.metricsService.requestAuditCounter.inc({ result: 'saved' });

      } catch {

        this.metricsService.requestAuditCounter.inc({ result: 'failed' });
        this.appLogger.warn('request.audit.failed');

      }

    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.isClosing = true;

    while (this.drainPromise) {

      await this.drainPromise;

    }
  }
}
@Injectable()
export class RequestAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly requestAuditRepository: RequestAuditRepository,
    private readonly metricsService: Metrics,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {

      return next.handle();

    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const requestStartedAt = performance.now();

    // Route templates keep order IDs out of Prometheus labels and request audit URLs.
    const routeTemplate =
      (request.route as { path?: string } | undefined)?.path ?? 'unmatched';

    response.once('finish', () =>
      this.metricsService.httpDurationHistogram.observe(
        {
          method: request.method,
          route: routeTemplate,
          status: String(response.statusCode),
        },
        (performance.now() - requestStartedAt) / 1000,
      ),
    );

    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {

      this.requestAuditRepository.enqueue({
        url: routeTemplate,
        method: request.method,
        payload: sanitizePayload(request.body),
        correlationId: String(response.locals.correlationId),
      });

    }

    return next.handle();
  }
}
