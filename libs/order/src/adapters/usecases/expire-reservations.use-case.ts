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

@Injectable()
export class ExpireReservationsUseCase implements BeforeApplicationShutdown {
  private isRunning = false;
  private isStopped = false;
  private expirationPromise?: Promise<void>;
  private readonly checkoutTopic: string;

  constructor(
    private readonly reservationRepository: ReservationRepository,
    private readonly orderMessaging: OrderMessaging,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly spansService: Spans,
    private readonly appLogger: AppLogger,
  ) {
    this.checkoutTopic = configService.getOrThrow<string>('CHECKOUT_TOPIC');
  }

  /** Called by the scheduler entrypoint once logging is bound to the app. */
  start(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {

      return;

    }

    const intervalMs = this.configService.getOrThrow<number>(
      'SCHEDULER_INTERVAL_MS',
    );

    this.schedulerRegistry.addInterval(
      INTERVAL_NAME,
      setInterval(() => void this.tick(), intervalMs),
    );

    this.appLogger.info('scheduler.expiration.started', {
      interval_ms: intervalMs,
    });

    void this.tick();
  }

  async tick(): Promise<void> {
    // A slow cycle must not overlap the next interval.
    if (this.isStopped || this.isRunning) {

      return;

    }

    this.isRunning = true;

    this.expirationPromise = this.execute()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.appLogger.error('scheduler.expiration.cycle_failed', {
          error_type: error instanceof Error ? error.name : 'UnknownError',
        });
      })
      .finally(() => {
        this.isRunning = false;
        this.expirationPromise = undefined;
      });

    await this.expirationPromise;
  }

  async execute(): Promise<number> {
    const expiredOrderIds = await this.reservationRepository.expiredOrderIds(
      EXPIRABLE_ORDER_STATUSES,
      EXPIRATION_BATCH_SIZE,
    );

    if (!expiredOrderIds.length) {

      return 0;

    }

    await this.orderMessaging.ensureConnected();

    let publishedEventCount = 0;

    for (const orderId of expiredOrderIds) {

      if (this.isStopped) {

        break;

      }

      if (await this.publishExpiration(orderId)) {

        publishedEventCount++;

      }

    }

    this.appLogger.info('scheduler.expiration.cycle', {
      found: expiredOrderIds.length,
      published: publishedEventCount,
    });

    return publishedEventCount;
  }

  private publishExpiration(orderId: string): Promise<boolean> {
    const traceContext: TraceContext = {
      correlation_id: randomUUID(),
      order_id: orderId,
      trace_id: randomBytes(16).toString('hex'),
      span_id: randomBytes(8).toString('hex'),
    };

    return executionContext.run(traceContext, async () => {
      try {

        await this.spansService.run('scheduler.publish_expiration', () => {
          const reservationExpiredEvent: ReservationExpiredEvent = {
            kind: ORDER_RESERVATION_EXPIRED,
            data: { order_id: orderId },
            meta: createEventMeta(traceContext.correlation_id),
          };

          return this.orderMessaging.publish(
            this.checkoutTopic,
            orderId,
            reservationExpiredEvent,
            {
              'x-correlation-id': traceContext.correlation_id,
            },
          );
        });

        return true;

      } catch (error) {

        this.appLogger.warn('scheduler.expiration.publish_failed', {
          error_type: error instanceof Error ? error.name : 'UnknownError',
        });

        return false;

      }
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.isStopped = true;

    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {

      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);

    }

    await this.expirationPromise;
  }
}
