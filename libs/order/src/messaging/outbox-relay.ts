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
  private relayPromise?: Promise<void>;
  private isStopped = false;
  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly orderMessaging: OrderMessaging,
    private readonly metricsService: Metrics,
    private readonly appLogger: AppLogger,
    private readonly spansService: Spans,
  ) {}

  @Interval(1000)
  async tick(): Promise<void> {
    if (this.isStopped || this.relayPromise) {

      return;

    }

    this.relayPromise = this.execute();

    try {

      await this.relayPromise;

    } catch {

      this.appLogger.error('outbox.relay.failed');

    } finally {

      this.relayPromise = undefined;

    }
  }

  async execute(): Promise<void> {
    const initialBacklog = await this.outboxRepository.backlog();

    this.metricsService.outboxBacklogGauge.set(initialBacklog.count);

    this.metricsService.oldestOutboxEventAgeGauge.set(
      initialBacklog.ageSeconds,
    );

    await this.orderMessaging.ensureConnected();
    const claimedEvents = await this.outboxRepository.claim();

    // The bounded batch publishes concurrently so later events do not wait out their leases.
    const publicationResults = await Promise.allSettled(
      claimedEvents.map(async (claimedEvent) => {
        const orderEvent = parseOrderEvent(claimedEvent.payload);

        if (!orderEvent) {

          throw new Error('Invalid order event in outbox');

        }

        if (!orderEvent.meta) {

          throw new Error('Outbox event without meta');

        }

        const { correlation_id: correlationId, ...eventTrace } =
          orderEvent.meta;

        const traceContext = {
          ...newTraceContext(correlationId),
          trace_id: eventTrace.trace_id,
          span_id: eventTrace.parent_span_id,
          order_id: claimedEvent.orderId,
        };

        await executionContext.run(traceContext, async () => {
          try {

            await this.spansService.run('outbox.publish', () =>
              this.orderMessaging.publish(
                claimedEvent.topic,
                claimedEvent.orderId,
                orderEvent,
                {
                  'x-correlation-id': correlationId,
                },
              ),
            );

            await this.outboxRepository.acknowledge(claimedEvent);
            this.metricsService.processingCounter.inc({ result: 'published' });

          } catch {

            await this.outboxRepository.release(claimedEvent);
            this.appLogger.warn('outbox.publish.failed');

          }
        });
      }),
    );

    const publicationFailure = publicationResults.find(
      (publicationResult) => publicationResult.status === 'rejected',
    );

    if (publicationFailure?.status === 'rejected') {

      throw publicationFailure.reason;

    }

    const remainingBacklog = await this.outboxRepository.backlog();

    this.metricsService.outboxBacklogGauge.set(remainingBacklog.count);

    this.metricsService.oldestOutboxEventAgeGauge.set(
      remainingBacklog.ageSeconds,
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.isStopped = true;
    await this.relayPromise?.catch(() => undefined);
  }
}
