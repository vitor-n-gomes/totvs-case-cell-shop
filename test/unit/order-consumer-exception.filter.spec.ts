import 'reflect-metadata';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { KafkaRetriableException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { lastValueFrom } from 'rxjs';
import { OrderConsumerExceptionFilter } from '@app/order/adapters/consumer/order-consumer-exception.filter';
import { OrderMessaging } from '@app/order/adapters/order.messaging';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Metrics } from '@app/platform/observability/metrics';

@Controller()
class WorkerTestController {
  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException('Worker unavailable');
  }
}

describe('OrderConsumerExceptionFilter', () => {
  async function createModule(publishMock: jest.Mock) {
    return Test.createTestingModule({
      controllers: [WorkerTestController],
      providers: [
        OrderConsumerExceptionFilter,
        Metrics,
        { provide: ConfigService, useValue: {} },
        { provide: OrderMessaging, useValue: { publish: publishMock } },
        { provide: AppLogger, useValue: { error: jest.fn() } },
      ],
    }).compile();
  }

  it('preserves HTTP error handling instead of sending HTTP errors to Kafka', async () => {
    const publishMock = jest.fn();
    const moduleRef = await createModule(publishMock);
    const app = moduleRef.createNestApplication();

    try {

      app.useGlobalFilters(app.get(OrderConsumerExceptionFilter));
      await app.init();

      const response = await request(app.getHttpServer())
        .get('/unavailable')
        .expect(503);

      expect(response.body).toMatchObject({
        statusCode: 503,
        message: 'Worker unavailable',
      });

      expect(publishMock).not.toHaveBeenCalled();

    } finally {

      await app.close();

    }
  });

  it('keeps a timeout eligible for redelivery without publishing to the DLQ', async () => {
    const publishMock = jest.fn();
    const moduleRef = await createModule(publishMock);
    const argumentsHost = new ExecutionContextHost([]);

    argumentsHost.setType('rpc');

    try {

      const filterResult = moduleRef
        .get(OrderConsumerExceptionFilter)
        .catch(new DOMException('deadline', 'TimeoutError'), argumentsHost);

      if (!filterResult) {

        throw new Error('Expected an observable for an RPC failure');

      }

      await expect(lastValueFrom(filterResult)).rejects.toBeInstanceOf(
        KafkaRetriableException,
      );

      expect(publishMock).not.toHaveBeenCalled();

    } finally {

      await moduleRef.close();

    }
  });
});
