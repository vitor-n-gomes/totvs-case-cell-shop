import { Controller, Get, Injectable, Res } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Response } from 'express';

@Injectable()
export class Metrics {
  readonly metricsRegistry = new Registry();
  readonly cacheRequestsCounter = new Counter({
    name: 'shop_cache_requests_total',
    help: 'Catalog cache outcomes',
    labelNames: ['result'],
    registers: [this.metricsRegistry],
  });
  readonly checkoutCounter = new Counter({
    name: 'shop_checkout_total',
    help: 'Checkout outcomes',
    labelNames: ['result'],
    registers: [this.metricsRegistry],
  });
  readonly reservationTransitionsCounter = new Counter({
    name: 'shop_reservations_total',
    help: 'Reservation transitions',
    labelNames: ['result'],
    registers: [this.metricsRegistry],
  });
  readonly processingCounter = new Counter({
    name: 'shop_processing_total',
    help: 'Worker outcomes',
    labelNames: ['result'],
    registers: [this.metricsRegistry],
  });
  readonly requestAuditCounter = new Counter({
    name: 'shop_request_log_total',
    help: 'Request audit outcomes',
    labelNames: ['result'],
    registers: [this.metricsRegistry],
  });
  readonly httpDurationHistogram = new Histogram({
    name: 'shop_http_duration_seconds',
    help: 'HTTP duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 5],
    registers: [this.metricsRegistry],
  });
  readonly activationStepDurationHistogram = new Histogram({
    name: 'shop_step_duration_seconds',
    help: 'Activation step duration',
    labelNames: ['step', 'result'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [this.metricsRegistry],
  });
  readonly outboxBacklogGauge = new Gauge({
    name: 'shop_outbox_pending',
    help: 'Pending outbox events',
    registers: [this.metricsRegistry],
  });
  readonly oldestOutboxEventAgeGauge = new Gauge({
    name: 'shop_outbox_oldest_seconds',
    help: 'Age of oldest pending event',
    registers: [this.metricsRegistry],
  });
}
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: Metrics) {}

  @Get()
  async get(@Res() response: Response): Promise<void> {
    response
      .type(this.metricsService.metricsRegistry.contentType)
      .send(await this.metricsService.metricsRegistry.metrics());
  }
}
