import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { KafkaJSError } from 'kafkajs';
import { lastValueFrom } from 'rxjs';
import { OrderConsumerExceptionFilter } from '@app/orders/adapters/consumer/order-consumer-exception.filter';
import { OrderMessaging } from '@app/orders/adapters/order.messaging';
import {
  IntegrationTimeoutError,
  PermanentActivationError,
} from '@app/orders/activation/guards/activation-errors';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { checkoutEvent, loggerMock } from './support/fixtures';

describe('OrderConsumerExceptionFilter RPC failures', () => {
  async function setup(payload: unknown = checkoutEvent()) {
    const publish = jest.fn().mockResolvedValue(undefined);
    const logger = loggerMock();

    const kafkaContext = {
      getMessage: () => ({ offset: '42' }),
      getPartition: () => 3,
      getTopic: () => 'checkout',
    } as unknown as KafkaContext;

    const host = new ExecutionContextHost([payload, kafkaContext]);

    host.setType('rpc');

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderConsumerExceptionFilter,
        Metrics,
        { provide: OrderMessaging, useValue: { publish } },
        {
          provide: ConfigService,
          useValue: new ConfigService({ CHECKOUT_TOPIC: 'checkout' }),
        },
        { provide: AppLogger, useValue: logger },
        { provide: HttpAdapterHost, useValue: {} },
      ],
    }).compile();

    const filter = moduleRef.get(OrderConsumerExceptionFilter);

    return {
      publish,
      logger,
      metric: jest.spyOn(moduleRef.get(Metrics).processingCounter, 'inc'),
      invoke: (error: unknown) => {
        const result = filter.catch(error, host);

        if (!result) {

          throw new Error('Expected RPC observable');

        }

        return lastValueFrom(result);
      },
    };
  }

  it.each([
    ['Kafka retry', new KafkaRetriableException('retry')],
    ['Kafka connection', new KafkaJSError('connection failed')],
    ['integration timeout', new IntegrationTimeoutError('timeout')],
    // Native DOMException inherits the host Error, outside Jest's VM realm.
    ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['deadlock', { driverError: { code: '40P01' } }],
    ['connection reset', { cause: { code: 'ECONNRESET' } }],
  ])(
    'keeps transient failure %s eligible for redelivery without DLQ publication',
    async (_label, failure) => {
      const { invoke, publish, metric } = await setup();

      await expect(invoke(failure)).rejects.toBeInstanceOf(
        KafkaRetriableException,
      );

      expect(publish).not.toHaveBeenCalled();
      expect(metric).not.toHaveBeenCalled();
    },
  );

  it('dead-letters a permanent error with original event and source headers', async () => {
    const event = checkoutEvent();
    const { invoke, publish, metric } = await setup(event);

    await invoke(new PermanentActivationError('Unknown order'));

    expect(publish).toHaveBeenCalledWith(
      'checkout.dlq',
      event.data.order_id,
      event,
      expect.objectContaining({
        'x-correlation-id': event.meta.correlation_id,
        'x-dlq-reason': 'Unknown order',
        'x-source-topic': 'checkout',
        'x-source-partition': '3',
        'x-source-offset': '42',
      }),
    );

    expect(metric).toHaveBeenCalledWith({ result: 'dlq' });
  });

  it.each([
    null,
    { kind: 'UNKNOWN', secret: 'private-value' },
    { kind: 'ORDER_CHECKOUT_INITIATED', secret: 'private-value' },
  ])(
    'dead-letters malformed payload %p without copying untrusted data',
    async (payload) => {
      const { invoke, publish, metric } = await setup(payload);

      await invoke(new Error('private upstream details'));

      expect(publish).toHaveBeenCalledWith(
        'checkout.dlq',
        'checkout:3:42',
        {
          kind:
            payload?.kind === 'ORDER_CHECKOUT_INITIATED'
              ? payload.kind
              : 'UNKNOWN',
          source: { topic: 'checkout', partition: 3, offset: '42' },
          reason: 'Invalid event payload',
        },
        expect.any(Object),
      );

      expect(JSON.stringify(publish.mock.calls)).not.toContain('private');
      expect(metric).toHaveBeenCalledWith({ result: 'invalid_dlq' });
    },
  );

  it('sanitizes unsafe error names and omits unexpected error messages', async () => {
    const { invoke, publish } = await setup();
    const failure = new Error('private response');

    failure.name = 'unsafe\nheader';
    await invoke(failure);

    expect(publish.mock.calls[0]![3]).toMatchObject({
      'x-error-type': 'UnknownError',
      'x-dlq-reason': 'Unexpected UnknownError',
    });
  });

  it('retries delivery if publishing to the DLQ fails', async () => {
    const { invoke, publish, metric, logger } = await setup();

    publish.mockRejectedValue(new Error('Kafka unavailable'));

    await expect(invoke(new Error('processing failed'))).rejects.toBeInstanceOf(
      KafkaRetriableException,
    );

    expect(metric).not.toHaveBeenCalled();

    expect(logger.error).toHaveBeenCalledWith('order.consumer.dlq.failed', {
      error_type: 'Error',
    });
  });
});
