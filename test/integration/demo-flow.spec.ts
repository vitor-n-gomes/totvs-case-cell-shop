import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Kafka, logLevel } from 'kafkajs';
import { createClient } from 'redis';
import request from 'supertest';
import { validateEnvironment } from '@app/platform/config/environment';
import { databaseOptions } from '@app/platform/database/options';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { ReceiptRepository } from '@app/demo/ports/receipt-repository';
import { receiptCacheKey } from '@app/demo/adapters/redis-receipt.cache';
import { MessageReceipt } from '@app/contracts';
import { configureApi } from '../../apps/api/src/configure-api';

async function eventually<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for asynchronous processing');
}

describe('HTTP → Kafka → worker → PostgreSQL → Redis', () => {
  let api: INestApplication | undefined;
  let worker: INestApplication | undefined;
  let database: DataSource | undefined;
  let kafka: Kafka | undefined;
  let admin: ReturnType<Kafka['admin']> | undefined;
  let producer: ReturnType<Kafka['producer']> | undefined;
  let redis: ReturnType<typeof createClient> | undefined;
  let topic: string;
  let groupId: string;
  const eventIds: string[] = [];

  beforeAll(async () => {
    config({ path: process.env.TEST_ENV_FILE ?? '.env.test.local' });
    const environment = validateEnvironment(process.env);
    const databaseUrl = new URL(environment.DATABASE_URL);
    const redisUrl = new URL(environment.REDIS_URL);
    // Never fall back to the application's database or its default Redis namespace.
    if (
      environment.NODE_ENV !== 'test' ||
      !databaseUrl.pathname.endsWith('_test') ||
      !['localhost', '127.0.0.1', 'postgres'].includes(databaseUrl.hostname) ||
      redisUrl.pathname !== '/1' ||
      !['localhost', '127.0.0.1', 'redis'].includes(redisUrl.hostname) ||
      !environment.KAFKA_BROKERS.every((broker) =>
        ['localhost', '127.0.0.1', 'kafka'].includes(
          broker.split(':')[0] ?? '',
        ),
      )
    ) {
      throw new Error(
        'Integration tests require local Kafka, a local *_test database, and local Redis database /1',
      );
    }
    topic = `casecellshop.test.${randomUUID()}`;
    groupId = `${topic}.worker`;
    process.env.KAFKA_TOPIC = topic;
    process.env.KAFKA_GROUP_ID = groupId;
    kafka = new Kafka({
      clientId: 'casecellshop-integration',
      brokers: environment.KAFKA_BROKERS,
      logLevel: logLevel.NOTHING,
    });
    admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    });
    database = new DataSource(databaseOptions(environment.DATABASE_URL));
    await database.initialize();
    await database.runMigrations();
    redis = createClient({
      url: environment.REDIS_URL,
      socket: { connectTimeout: 1000, reconnectStrategy: false },
    });
    redis.on('error', () => undefined);
    await redis.connect();
    producer = kafka.producer({ allowAutoTopicCreation: false });
    await producer.connect();

    // Load modules after setting the isolated topic so both application configurations agree.
    const { ApiModule } = jest.requireActual<
      typeof import('../../apps/api/src/app.module')
    >('../../apps/api/src/app.module');
    const { WorkerModule } = jest.requireActual<
      typeof import('../../apps/worker/src/app.module')
    >('../../apps/worker/src/app.module');
    api = await NestFactory.create(ApiModule, {
      logger: false,
      abortOnError: false,
    });
    configureApi(api);
    await api.init();
    worker = await NestFactory.create(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    await worker.init();
    await eventually(
      async () =>
        (await request(worker!.getHttpServer()).get('/health/ready')).status,
      (status) => status === 200,
    );
  });

  afterAll(async () => {
    const results = await Promise.allSettled([worker?.close(), api?.close()]);
    results.push(
      ...(await Promise.allSettled([
        (async () => {
          if (!database?.isInitialized) return;
          try {
            if (eventIds.length)
              await database.query(
                'DELETE FROM demo_message_receipts WHERE event_id = ANY($1::uuid[])',
                [eventIds],
              );
          } finally {
            await database.destroy();
          }
        })(),
        (async () => {
          if (!redis?.isOpen) return;
          try {
            if (eventIds.length && redis.isReady)
              await redis.del(eventIds.map(receiptCacheKey));
          } finally {
            redis.destroy();
          }
        })(),
        producer?.disconnect(),
        (async () => {
          if (!admin) return;
          try {
            const { groups } = await admin.listGroups();
            if (groups.some((group) => group.groupId === groupId))
              await admin.deleteGroups([groupId]);
          } finally {
            try {
              if (topic) await admin.deleteTopics({ topics: [topic] });
            } finally {
              await admin.disconnect();
            }
          }
        })(),
      ])),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Integration resource cleanup failed',
      );
  });

  async function publishAndWait(): Promise<MessageReceipt> {
    const correlationId = randomUUID();
    const published = await request(api!.getHttpServer())
      .post('/demo/messages')
      .set('x-correlation-id', correlationId)
      .send({ message: 'integration hello' })
      .expect(202);
    const eventId = String(published.body.eventId);
    eventIds.push(eventId);
    const response = await eventually(
      () => request(api!.getHttpServer()).get(`/demo/messages/${eventId}`),
      (value) => value.status === 200,
    );
    expect(response.body).toMatchObject({ eventId, correlationId });
    return response.body as MessageReceipt;
  }

  it('persists a published event and preserves correlation across application boundaries', async () => {
    const correlationId = randomUUID();
    const published = await request(api!.getHttpServer())
      .post('/demo/messages')
      .set('x-correlation-id', correlationId)
      .send({ message: 'integration hello' })
      .expect(202);
    const eventId = String(published.body.eventId);
    eventIds.push(eventId);
    const response = await eventually(
      () => request(api!.getHttpServer()).get(`/demo/messages/${eventId}`),
      (value) => value.status === 200,
    );
    const saved = response.body as MessageReceipt;
    expect(saved).toMatchObject({
      eventId,
      correlationId,
      message: 'integration hello',
      schemaVersion: 1,
    });
    const rows: { event_id: string }[] = await database!.query(
      'SELECT event_id FROM demo_message_receipts WHERE event_id = $1',
      [eventId],
    );
    expect(rows).toHaveLength(1);
  });

  it('persists only one receipt when Kafka delivers the same event repeatedly', async () => {
    const saved = await publishAndWait();
    const duplicate = {
      schemaVersion: saved.schemaVersion,
      eventId: saved.eventId,
      correlationId: saved.correlationId,
      occurredAt: saved.occurredAt,
      message: saved.message,
    };
    await producer!.send({
      topic,
      messages: Array.from({ length: 5 }, () => ({
        key: saved.eventId,
        value: JSON.stringify(duplicate),
      })),
    });
    // A barrier event on the same partition proves all preceding duplicates were handled.
    const barrier = { ...duplicate, eventId: randomUUID(), message: 'barrier' };
    eventIds.push(barrier.eventId);
    await producer!.send({
      topic,
      messages: [{ key: barrier.eventId, value: JSON.stringify(barrier) }],
    });
    await eventually(
      () =>
        database!.query(
          'SELECT event_id FROM demo_message_receipts WHERE event_id = $1',
          [barrier.eventId],
        ),
      (rows: unknown[]) => rows.length === 1,
    );
    const rows: { received_at: Date }[] = await database!.query(
      'SELECT received_at FROM demo_message_receipts WHERE event_id = $1',
      [saved.eventId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.received_at.toISOString()).toBe(saved.receivedAt);
  });

  it('serves cached receipts without accessing PostgreSQL and sets a bounded TTL', async () => {
    const saved = await publishAndWait();
    await eventually(
      async () => {
        await request(api!.getHttpServer())
          .get(`/demo/messages/${saved.eventId}`)
          .expect(200);
        return redis!.get(receiptCacheKey(saved.eventId));
      },
      (value) => value !== null,
    );
    const lookup = jest.spyOn(api!.get(ReceiptRepository), 'findById');
    try {
      await request(api!.getHttpServer())
        .get(`/demo/messages/${saved.eventId}`)
        .expect(200);
      expect(lookup).not.toHaveBeenCalled();
      const ttl = await redis!.ttl(receiptCacheKey(saved.eventId));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    } finally {
      lookup.mockRestore();
    }
  });

  it('does not cache missing receipts', async () => {
    const eventId = randomUUID();
    await request(api!.getHttpServer())
      .get(`/demo/messages/${eventId}`)
      .expect(404);
    expect(await redis!.get(receiptCacheKey(eventId))).toBeNull();
  });

  it('continues serving database reads when its Redis connection is unavailable', async () => {
    const saved = await publishAndWait();
    api!.get(RedisConnection).client.destroy();
    const lookup = jest.spyOn(api!.get(ReceiptRepository), 'findById');
    try {
      const response = await request(api!.getHttpServer())
        .get(`/demo/messages/${saved.eventId}`)
        .expect(200);
      expect(response.body).toEqual(saved);
      expect(lookup).toHaveBeenCalledWith(saved.eventId);
      await request(api!.getHttpServer()).get('/health/ready').expect(200);
      const status = await request(api!.getHttpServer())
        .get('/health/cache')
        .expect(200);
      expect(status.body).toEqual({ redis: 'down', required: false });
    } finally {
      lookup.mockRestore();
      await api!.get(RedisConnection).client.connect();
    }
  });
});
