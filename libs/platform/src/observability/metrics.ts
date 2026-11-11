import { Controller, Get, Injectable, Res } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Response } from 'express';

@Injectable()
export class Metrics {
  readonly registry = new Registry();
  readonly cache = new Counter({
    name: 'shop_cache_requests_total',
    help: 'Catalog cache outcomes',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly checkout = new Counter({
    name: 'shop_checkout_total',
    help: 'Checkout outcomes',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly reservations = new Counter({
    name: 'shop_reservations_total',
    help: 'Reservation transitions',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly processing = new Counter({
    name: 'shop_processing_total',
    help: 'Worker outcomes',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly audit = new Counter({
    name: 'shop_request_log_total',
    help: 'Request audit outcomes',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly http = new Histogram({
    name: 'shop_http_duration_seconds',
    help: 'HTTP duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 5],
    registers: [this.registry],
  });
  readonly steps = new Histogram({
    name: 'shop_step_duration_seconds',
    help: 'Activation step duration',
    labelNames: ['step', 'result'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [this.registry],
  });
  readonly backlog = new Gauge({
    name: 'shop_outbox_pending',
    help: 'Pending outbox events',
    registers: [this.registry],
  });
  readonly oldest = new Gauge({
    name: 'shop_outbox_oldest_seconds',
    help: 'Age of oldest pending event',
    registers: [this.registry],
  });
}
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}
  @Get()
  async get(@Res() response: Response): Promise<void> {
    response
      .type(this.metrics.registry.contentType)
      .send(await this.metrics.registry.metrics());
  }
}
