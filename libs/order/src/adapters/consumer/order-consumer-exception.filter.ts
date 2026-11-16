import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import { KafkaJSAggregateError, KafkaJSError } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { catchError, from, Observable, throwError } from 'rxjs';
import {
  IntegrationTimeoutError,
  PermanentActivationError,
} from '@app/order/activation/guards/activation-errors';
import {
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  parseOrderEvent,
} from '@app/order/messaging/order-events';
import { isTransientDatabaseFailure } from '@app/platform/database/transient-db-error';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Metrics } from '@app/platform/observability/metrics';
import { OrderMessaging } from '../order.messaging';

function eventKind(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'kind' in payload &&
    (payload.kind === ORDER_CHECKOUT_INITIATED ||
      payload.kind === ORDER_RESERVATION_EXPIRED)
  ) {

    return payload.kind;

  }

  return 'UNKNOWN';
}

function errorType(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';

  return /^[A-Za-z][A-Za-z0-9._-]{0,80}$/.test(name) ? name : 'UnknownError';
}

@Catch()
@Injectable()
export class OrderConsumerExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly messaging: OrderMessaging,
    private readonly config: ConfigService,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  catch(error: unknown, host: ArgumentsHost): Observable<void> | void {
    if (host.getType() !== 'rpc') {

      new BaseExceptionFilter(this.httpAdapterHost.httpAdapter).catch(
        error,
        host,
      );

      return;

    }

    if (
      error instanceof KafkaRetriableException ||
      error instanceof KafkaJSError ||
      error instanceof KafkaJSAggregateError ||
      error instanceof IntegrationTimeoutError ||
      (error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
      isTransientDatabaseFailure(error)
    ) {

      return throwError(
        () => new KafkaRetriableException('Order event processing failed'),
      );

    }

    return from(this.sendToDlq(error, host)).pipe(
      catchError((failure: unknown) => {
        this.logger.error('order.consumer.dlq.failed', {
          error_type: errorType(failure),
        });

        return throwError(
          () => new KafkaRetriableException('Dead-letter publication failed'),
        );
      }),
    );
  }

  private async sendToDlq(error: unknown, host: ArgumentsHost): Promise<void> {
    const rpc = host.switchToRpc();
    const payload: unknown = rpc.getData();
    const context = rpc.getContext<KafkaContext>();
    const event = parseOrderEvent(payload);
    const kind = event?.kind ?? eventKind(payload);

    const source = {
      topic: context.getTopic(),
      partition: context.getPartition(),
      offset: context.getMessage().offset,
    };

    const reason = !event
      ? 'Invalid event payload'
      : error instanceof PermanentActivationError
        ? error.message
        : `Unexpected ${errorType(error)}`;

    const correlationId = event?.meta?.correlation_id ?? randomUUID();

    await this.messaging.publish(
      `${this.config.getOrThrow<string>('CHECKOUT_TOPIC')}.dlq`,
      event?.data.order_id ??
        `${source.topic}:${source.partition}:${source.offset}`,
      event ?? { kind, source, reason },
      {
        'x-correlation-id': correlationId,
        'x-dlq-reason': reason,
        'x-error-type': errorType(error),
        'x-event-kind': kind,
        'x-source-topic': source.topic,
        'x-source-partition': String(source.partition),
        'x-source-offset': source.offset,
      },
    );

    this.metrics.processing.inc({ result: event ? 'dlq' : 'invalid_dlq' });

    this.logger.error('order.consumer.dead_lettered', {
      correlation_id: correlationId,
      order_id: event?.data.order_id,
      kind,
      source_topic: source.topic,
      source_partition: source.partition,
      source_offset: source.offset,
      error_type: errorType(error),
    });
  }
}
