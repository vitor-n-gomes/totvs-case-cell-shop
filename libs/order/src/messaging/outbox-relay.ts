import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OrderMessaging } from '../adapters/order.messaging';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import {
  executionContext,
  newTraceContext,
} from '@app/platform/observability/context';
import { Spans } from '@app/platform/observability/spans';
import { OutboxRepository } from '../repositories/outbox.repository';
import { parseOrderEvent } from '@app/order/messaging/order-events';

@Injectable()
export class OutboxRelay implements BeforeApplicationShutdown {
  private flight?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly messaging: OrderMessaging,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly spans: Spans,
  ) {}

  @Interval(1000)
  async tick(): Promise<void> {
    if (this.stopped || this.flight) return;

    this.flight = this.execute();

    try {
      await this.flight;
    } catch {
      this.logger.error('outbox.relay.failed');
    } finally {
      this.flight = undefined;
    }
  }

  async execute(): Promise<void> {
    const before = await this.outbox.backlog();

    this.metrics.backlog.set(before.count);
    this.metrics.oldest.set(before.ageSeconds);
    await this.messaging.ensureConnected();
    const events = await this.outbox.claim();

    // The bounded batch publishes concurrently so later events do not wait out their leases.
    const results = await Promise.allSettled(
      events.map(async (event) => {
        const payload = parseOrderEvent(event.payload);

        if (!payload) throw new Error('Invalid order event in outbox');

        if (!payload.meta) throw new Error('Outbox event without meta');

        const { correlation_id: correlationId, ...trace } = payload.meta;

        const context = {
          ...newTraceContext(correlationId),
          trace_id: trace.trace_id,
          span_id: trace.parent_span_id,
          order_id: event.orderId,
        };

        await executionContext.run(context, async () => {
          try {
            await this.spans.run('outbox.publish', () =>
              this.messaging.publish(event.topic, event.orderId, payload, {
                'x-correlation-id': correlationId,
              }),
            );

            await this.outbox.acknowledge(event);
            this.metrics.processing.inc({ result: 'published' });
          } catch {
            await this.outbox.release(event);
            this.logger.warn('outbox.publish.failed');
          }
        });
      }),
    );

    const failure = results.find((result) => result.status === 'rejected');

    if (failure?.status === 'rejected') throw failure.reason;

    const backlog = await this.outbox.backlog();

    this.metrics.backlog.set(backlog.count);
    this.metrics.oldest.set(backlog.ageSeconds);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.flight?.catch(() => undefined);
  }
}
