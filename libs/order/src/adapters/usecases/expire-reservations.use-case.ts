import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppLogger } from '@app/platform/logging/app-logger';
import {
  executionContext,
  TraceContext,
} from '@app/platform/observability/context';
import { Spans } from '@app/platform/observability/spans';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { EXPIRABLE_ORDER_STATUSES } from '@app/order/domain/shared/types/order.type';
import {
  ORDER_RESERVATION_EXPIRED,
  ReservationExpiredEvent,
} from '@app/order/messaging/order-events';
import { createEventMeta } from '@app/order/messaging/event.util';
import { OrderMessaging } from '../order.messaging';

export const EXPIRATION_BATCH_SIZE = 50;
const INTERVAL_NAME = 'scheduler.reservation_expiration';

/**
 * Anemic producer: finds orders whose reservation expired and publishes
 * ORDER_RESERVATION_EXPIRED. It never changes order status or stock; the
 * consumer's ReservationExpiredHandler owns the idempotent release.
 */
@Injectable()
export class ExpireReservationsUseCase implements BeforeApplicationShutdown {
  private isRunning = false;
  private stopped = false;
  private flight?: Promise<void>;
  private readonly topic: string;

  constructor(
    private readonly reservations: ReservationRepository,
    private readonly messaging: OrderMessaging,
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
    private readonly spans: Spans,
    private readonly logger: AppLogger,
  ) {
    this.topic = config.getOrThrow<string>('CHECKOUT_TOPIC');
  }

  /** Called by the scheduler entrypoint once logging is bound to the app. */
  start(): void {
    if (this.registry.doesExist('interval', INTERVAL_NAME)) return;

    const intervalMs = this.config.getOrThrow<number>('SCHEDULER_INTERVAL_MS');

    this.registry.addInterval(
      INTERVAL_NAME,
      setInterval(() => void this.tick(), intervalMs),
    );

    this.logger.info('scheduler.expiration.started', {
      interval_ms: intervalMs,
    });

    void this.tick();
  }

  async tick(): Promise<void> {
    // A slow cycle must not overlap the next interval.
    if (this.stopped || this.isRunning) return;

    this.isRunning = true;

    this.flight = this.execute()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error('scheduler.expiration.cycle_failed', {
          error_type: error instanceof Error ? error.name : 'UnknownError',
        });
      })
      .finally(() => {
        this.isRunning = false;
        this.flight = undefined;
      });

    await this.flight;
  }

  async execute(): Promise<number> {
    const orderIds = await this.reservations.expiredOrderIds(
      EXPIRABLE_ORDER_STATUSES,
      EXPIRATION_BATCH_SIZE,
    );

    if (!orderIds.length) return 0;

    await this.messaging.ensureConnected();

    let published = 0;

    for (const orderId of orderIds) {
      if (this.stopped) break;

      if (await this.publishExpiration(orderId)) published++;
    }

    this.logger.info('scheduler.expiration.cycle', {
      found: orderIds.length,
      published,
    });

    return published;
  }

  private publishExpiration(orderId: string): Promise<boolean> {
    const context: TraceContext = {
      correlation_id: randomUUID(),
      order_id: orderId,
      trace_id: randomBytes(16).toString('hex'),
      span_id: randomBytes(8).toString('hex'),
    };

    return executionContext.run(context, async () => {
      try {
        await this.spans.run('scheduler.publish_expiration', () => {
          const event: ReservationExpiredEvent = {
            kind: ORDER_RESERVATION_EXPIRED,
            data: { order_id: orderId },
            meta: createEventMeta(context.correlation_id),
          };

          return this.messaging.publish(this.topic, orderId, event, {
            'x-correlation-id': context.correlation_id,
          });
        });

        return true;
      } catch (error) {
        this.logger.warn('scheduler.expiration.publish_failed', {
          error_type: error instanceof Error ? error.name : 'UnknownError',
        });

        return false;
      }
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;

    if (this.registry.doesExist('interval', INTERVAL_NAME))
      this.registry.deleteInterval(INTERVAL_NAME);

    await this.flight;
  }
}
