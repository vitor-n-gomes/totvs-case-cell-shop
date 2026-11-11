import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { KafkaConnection } from '@app/platform/messaging/kafka-connection';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import {
  executionContext,
  newTraceContext,
} from '@app/platform/observability/context';
import { Spans } from '@app/platform/observability/spans';
import { OutboxRepository } from './outbox.repository';

@Injectable()
export class OutboxRelay implements BeforeApplicationShutdown {
  private flight?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly kafka: KafkaConnection,
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
    this.metrics.backlog.set(Number(before.count));
    this.metrics.oldest.set(Number(before.age));
    await this.kafka.ensureConnected();
    const events = await this.outbox.claim();
    // The bounded batch publishes concurrently so later events do not wait out their leases.
    await Promise.all(
      events.map(async (event) => {
        const correlationId = String(event.payload.correlation_id);
        const context = {
          ...newTraceContext(correlationId),
          trace_id: String(event.payload.trace_id),
          span_id: String(event.payload.parent_span_id),
          order_id: event.order_id,
        };
        await executionContext.run(context, async () => {
          try {
            await this.spans.run('outbox.publish', () =>
              this.kafka.producer.send({
                topic: event.topic,
                acks: -1,
                messages: [
                  {
                    key: event.order_id,
                    value: JSON.stringify(event.payload),
                    headers: { 'x-correlation-id': correlationId },
                  },
                ],
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
    const backlog = await this.outbox.backlog();
    this.metrics.backlog.set(Number(backlog.count));
    this.metrics.oldest.set(Number(backlog.age));
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.flight?.catch(() => undefined);
  }
}
