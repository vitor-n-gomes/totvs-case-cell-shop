import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { KafkaConnection } from '@app/platform/messaging/kafka-connection';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { AppLogger } from '@app/platform/logging/app-logger';
import { configureApi } from '../../apps/api/src/configure-api';

describe('Application module composition without support services', () => {
  const apps: INestApplication[] = [];
  const previousEnvironment = { ...process.env };

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    process.env = previousEnvironment;
  });

  it('boots both module graphs and keeps business routes out of the worker', async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/casecellshop_test',
      REDIS_URL: 'redis://localhost:6379/1',
      KAFKA_BROKERS: 'localhost:9092',
    });
    const { ApiModule } = jest.requireActual<
      typeof import('../../apps/api/src/app.module')
    >('../../apps/api/src/app.module');
    const { WorkerModule } = jest.requireActual<
      typeof import('../../apps/worker/src/app.module')
    >('../../apps/worker/src/app.module');
    let joinGroup = () => undefined;
    const consumer = {
      events: {
        GROUP_JOIN: 'join',
        CRASH: 'crash',
        DISCONNECT: 'disconnect',
        STOP: 'stop',
      },
      on: (name: string, callback: () => undefined) => {
        if (name === 'join') joinGroup = callback;
      },
      connect: jest.fn(),
      subscribe: jest.fn(),
      run: async () => {
        joinGroup();
      },
      stop: jest.fn(),
      disconnect: jest.fn(),
    };
    const send = jest.fn().mockResolvedValue([]);
    for (const root of [ApiModule, WorkerModule]) {
      const module = await Test.createTestingModule({ imports: [root] })
        .overrideProvider(DataSource)
        .useValue({
          options: { type: 'postgres' },
          entityMetadatas: [],
          isInitialized: false,
          getRepository: () => ({ findOneBy: async () => null }),
          query: async () => [],
        })
        .overrideProvider(KafkaConnection)
        .useValue({
          kafka: { consumer: () => consumer },
          producer: { send },
          checkTopic: async () => undefined,
        })
        .overrideProvider(RedisConnection)
        .useValue({ client: { isReady: false } })
        .overrideProvider(AppLogger)
        .useValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() })
        .compile();
      const app = module.createNestApplication();
      apps.push(app);
      if (root === ApiModule) configureApi(app);
      await app.init();
      await request(app.getHttpServer()).get('/health/live').expect(200);
      await request(app.getHttpServer()).get('/health/ready').expect(200);
      if (root === ApiModule) {
        const response = await request(app.getHttpServer())
          .post('/demo/messages')
          .send({ message: 'composition test' })
          .expect(202);
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [expect.objectContaining({ key: response.body.eventId })],
          }),
        );
      } else {
        await request(app.getHttpServer())
          .post('/demo/messages')
          .send({ message: 'not a worker endpoint' })
          .expect(404);
      }
    }
  });
});
