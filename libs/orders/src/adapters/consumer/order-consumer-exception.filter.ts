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
} from '../../activation/guards/activation-errors';
import {
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  parseOrderEvent,
} from '../../messaging/order-events';
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
  const errorName = error instanceof Error ? error.name : 'UnknownError';

  return /^[A-Za-z][A-Za-z0-9._-]{0,80}$/.test(errorName)
    ? errorName
    : 'UnknownError';
}

@Catch()
@Injectable()
export class OrderConsumerExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly orderMessaging: OrderMessaging,
    private readonly configService: ConfigService,
    private readonly metricsService: Metrics,
    private readonly appLogger: AppLogger,
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
      catchError((publicationError: unknown) => {
        this.appLogger.error('order.consumer.dlq.failed', {
          error_type: errorType(publicationError),
        });

        return throwError(
          () => new KafkaRetriableException('Dead-letter publication failed'),
        );
      }),
    );
  }

  private async sendToDlq(error: unknown, host: ArgumentsHost): Promise<void> {
    const rpcContext = host.switchToRpc();
    const payload: unknown = rpcContext.getData();
    const kafkaContext = rpcContext.getContext<KafkaContext>();
    const orderEvent = parseOrderEvent(payload);
    const orderEventKind = orderEvent?.kind ?? eventKind(payload);

    const sourceMessage = {
      topic: kafkaContext.getTopic(),
      partition: kafkaContext.getPartition(),
      offset: kafkaContext.getMessage().offset,
    };

    const deadLetterReason = !orderEvent
      ? 'Invalid event payload'
      : error instanceof PermanentActivationError
        ? error.message
        : `Unexpected ${errorType(error)}`;

    const correlationId = orderEvent?.meta?.correlation_id ?? randomUUID();

    await this.orderMessaging.publish(
      `${this.configService.getOrThrow<string>('CHECKOUT_TOPIC')}.dlq`,
      orderEvent?.data.order_id ??
        `${sourceMessage.topic}:${sourceMessage.partition}:${sourceMessage.offset}`,
      orderEvent ?? {
        kind: orderEventKind,
        source: sourceMessage,
        reason: deadLetterReason,
      },
      {
        'X-Correlation-Id': correlationId,
        'x-dlq-reason': deadLetterReason,
        'x-error-type': errorType(error),
        'x-event-kind': orderEventKind,
        'x-source-topic': sourceMessage.topic,
        'x-source-partition': String(sourceMessage.partition),
        'x-source-offset': sourceMessage.offset,
      },
    );

    this.metricsService.processingCounter.inc({
      result: orderEvent ? 'dlq' : 'invalid_dlq',
    });

    this.appLogger.error('order.consumer.dead_lettered', {
      correlation_id: correlationId,
      order_id: orderEvent?.data.order_id,
      kind: orderEventKind,
      source_topic: sourceMessage.topic,
      source_partition: sourceMessage.partition,
      source_offset: sourceMessage.offset,
      error_type: errorType(error),
    });
  }
}
