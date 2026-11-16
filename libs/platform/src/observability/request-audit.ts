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
  if (depth > 6) return '[truncated]';

  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((entry) => sanitizePayload(entry, depth + 1));

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
  private readonly queue: AuditEntry[] = [];
  private draining?: Promise<void>;
  private closing = false;
  constructor(
    private readonly database: DataSource,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  enqueue(entry: AuditEntry): void {
    if (this.closing || this.queue.length >= 1000) {
      this.metrics.audit.inc({ result: 'dropped' });

      return;
    }

    this.queue.push(entry);
    this.startDrain();
  }

  private startDrain(): void {
    if (!this.draining) {
      this.draining = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.drain())
        .finally(() => {
          this.draining = undefined;

          if (this.queue.length) this.startDrain();
        });
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const entry = this.queue.shift()!;

      try {
        await this.database.query(
          'INSERT INTO request_log (id,url,method,payload,correlation_id) VALUES ($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            entry.url,
            entry.method,
            JSON.stringify(entry.payload),
            entry.correlationId,
          ],
        );

        this.metrics.audit.inc({ result: 'saved' });
      } catch {
        this.metrics.audit.inc({ result: 'failed' });
        this.logger.warn('request.audit.failed');
      }
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;

    while (this.draining) await this.draining;
  }
}
@Injectable()
export class RequestAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: RequestAuditRepository,
    private readonly metrics: Metrics,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const started = performance.now();

    // Route templates keep order IDs out of Prometheus labels and request audit URLs.
    const route =
      (request.route as { path?: string } | undefined)?.path ?? 'unmatched';

    response.once('finish', () =>
      this.metrics.http.observe(
        { method: request.method, route, status: String(response.statusCode) },
        (performance.now() - started) / 1000,
      ),
    );

    if (['POST', 'PUT', 'DELETE'].includes(request.method))
      this.audit.enqueue({
        url: route,
        method: request.method,
        payload: sanitizePayload(request.body),
        correlationId: String(response.locals.correlationId),
      });

    return next.handle();
  }
}
