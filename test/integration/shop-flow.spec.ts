import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Kafka, logLevel } from 'kafkajs';
import { createClient } from 'redis';
import request from 'supertest';
import {
  CheckoutEvent,
  PaymentType,
  Environment,
  OrderStatus,
  ProcessingStatus,
} from '@app/contracts';
import { databaseOptions } from '@app/platform/database/options';
import { validateEnvironment } from '@app/platform/config/environment';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';
import { RequestAuditRepository } from '@app/platform/observability/request-audit';
import { KafkaService } from '@app/platform/kafka/kafka.service';
import { OrderMessaging } from '@app/order/adapters/order.messaging';
import { HealthService } from '@app/platform/health/health.service';
import { kafkaConsumerOptions } from '@app/platform/kafka/kafka.options';
import { TopicKafkaServer } from '@app/platform/kafka/topic-kafka.server';
import {
  ORDER_EVENT_PATTERN,
  ORDER_KAFKA_TRANSPORT,
} from '@app/platform/kafka/kafka.topics';
import { ActiveOrderUseCase } from '@app/order/activation/active-order.use-case';
import { OutboxRepository } from '@app/order/repositories/outbox.repository';
import { OutboxRelay } from '@app/order/messaging/outbox-relay';
import { ExpireReservationsUseCase } from '@app/order/adapters/usecases/expire-reservations';
import { ActivateOrderStep } from '@app/order/activation/steps/database-steps';
import { IntegrationSimulator } from '@app/order/activation/steps/integration-steps';
import { ProductRepository } from '@app/shop/catalog/product.repository';
import {
  GetProducts,
  CATALOG_KEY,
  CATALOG_LOCK,
} from '@app/shop/catalog/get-products';
import { ProcessOrderEventUseCase } from '@app/order/adapters/usecases/process-order-event.use-case';
import { configureApi } from '../../apps/http/src/configure-api';

async function eventually(read: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Asynchronous condition timed out');
}

describe('Storefront consistency with PostgreSQL, Redis and Kafka', () => {
  let api: INestApplication, worker: INestApplication, database: DataSource;
  let redis: ReturnType<typeof createClient>,
    admin: ReturnType<Kafka['admin']>,
    producer: ReturnType<Kafka['producer']>;
  let topic: string, groupId: string;
  const productIds: string[] = [],
    orderIds: string[] = [],
    correlations: string[] = [];
  beforeAll(async () => {
    config({ path: process.env.TEST_ENV_FILE ?? '.env.test.local' });
    const environment = validateEnvironment(process.env);
    const dbUrl = new URL(environment.DATABASE_URL),
      redisUrl = new URL(environment.REDIS_URL);
    const local = ['localhost', '127.0.0.1', 'postgres', 'redis', 'kafka'];
    if (
      environment.NODE_ENV !== 'test' ||
      !dbUrl.pathname.endsWith('_test') ||
      !local.includes(dbUrl.hostname) ||
      redisUrl.pathname !== '/1' ||
      !local.includes(redisUrl.hostname) ||
      !environment.KAFKA_BROKERS.every((broker) =>
        local.includes(broker.split(':')[0]!),
      )
    )
      throw new Error('Dedicated local test services required');
    topic = `casecellshop.test.${randomUUID()}`;
    groupId = `${topic}.worker`;
    process.env.KAFKA_TOPIC = `${topic}.demo`;
    process.env.CHECKOUT_TOPIC = topic;
    process.env.KAFKA_GROUP_ID = groupId;
    const kafka = new Kafka({
      clientId: topic,
      brokers: environment.KAFKA_BROKERS,
      logLevel: logLevel.NOTHING,
    });
    admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [topic, `${topic}.demo`, `${topic}.dlq`].map((name) => ({
        topic: name,
        numPartitions: 1,
        replicationFactor: 1,
      })),
    });
    producer = kafka.producer();
    await producer.connect();
    database = new DataSource(databaseOptions(environment.DATABASE_URL));
    await database.initialize();
    await database.runMigrations();
    redis = createClient({ url: environment.REDIS_URL });
    redis.on('error', () => undefined);
    await redis.connect();
    await redis.del([CATALOG_KEY, CATALOG_LOCK]);
    const { HttpModule } = jest.requireActual<
      typeof import('../../apps/http/src/http.module')
    >('../../apps/http/src/http.module');
    const { ConsumerModule } = jest.requireActual<
      typeof import('../../apps/consumer/consumer.module')
    >('../../apps/consumer/consumer.module');
    api = await NestFactory.create(HttpModule, {
      logger: false,
      abortOnError: false,
    });
    configureApi(api);
    await api.init();
    worker = await NestFactory.create(ConsumerModule, {
      logger: false,
      abortOnError: false,
    });
    const health = worker.get(HealthService);
    health.checkoutConsumerReady = false;
    worker.connectMicroservice({
      strategy: new TopicKafkaServer(
        kafkaConsumerOptions(worker.get(ConfigService), `${groupId}-checkout`),
        ORDER_KAFKA_TRANSPORT,
        ORDER_EVENT_PATTERN,
        topic,
        (ready) => {
          health.checkoutConsumerReady = ready;
        },
      ),
    });
    await worker.startAllMicroservices();
    await worker.init();
    const scheduler = worker.get(SchedulerRegistry);
    for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
    for (const name of scheduler.getCronJobs().keys())
      scheduler.deleteCronJob(name);
    await eventually(
      async () =>
        (await request(worker.getHttpServer()).get('/health/ready')).status ===
        200,
    );
  });
  afterAll(async () => {
    try {
      await worker?.close();
      await api?.close();
      if (database?.isInitialized) {
        if (orderIds.length) {
          for (const table of [
            'outbox_events',
            'idempotency_log',
            'stock_reservation',
            'order_item',
          ])
            await database.query(
              `DELETE FROM ${table} WHERE order_id=ANY($1::uuid[])`,
              [orderIds],
            );
          await database.query('DELETE FROM "order" WHERE id=ANY($1::uuid[])', [
            orderIds,
          ]);
        }
        if (productIds.length) {
          await database.query(
            'DELETE FROM stock WHERE product_id=ANY($1::uuid[])',
            [productIds],
          );
          await database.query('DELETE FROM product WHERE id=ANY($1::uuid[])', [
            productIds,
          ]);
        }
        if (correlations.length)
          await database.query(
            'DELETE FROM request_log WHERE correlation_id=ANY($1::uuid[])',
            [correlations],
          );
      }
    } finally {
      if (database?.isInitialized) await database.destroy();
      if (redis?.isOpen) {
        await redis.del([CATALOG_KEY, CATALOG_LOCK]);
        redis.destroy();
      }
      await producer?.disconnect();
      if (admin) {
        try {
          const { groups } = await admin.listGroups();
          const owned = groups
            .filter((group) => group.groupId.startsWith(groupId))
            .map((group) => group.groupId);
          if (owned.length) await admin.deleteGroups(owned);
          await admin.deleteTopics({
            topics: [topic, `${topic}.demo`, `${topic}.dlq`],
          });
        } finally {
          await admin.disconnect();
        }
      }
    }
  });
  afterEach(() => {
    worker?.get(ConfigService).set('ERP_FAILURES', 0);
    worker?.get(ConfigService).set('EMAIL_FAILURES', 0);
    worker?.get(ConfigService).set('SIMULATOR_PERMANENT_FAILURE', 'none');
  });
  async function product(quantity = 10): Promise<string> {
    const id = randomUUID();
    productIds.push(id);
    await database.query(
      "INSERT INTO product (id,name,product_key,net_price,list_price) VALUES ($1,'Case',$2,10.00,12.00)",
      [id, id],
    );
    await database.query(
      'INSERT INTO stock (id,product_id,physical_quantity) VALUES ($1,$2,$3)',
      [randomUUID(), id, quantity],
    );
    return id;
  }
  function body(productId: string, quantity = 1) {
    return {
      paymentType: PaymentType.PrePaid,
      dueDate: '2026-11-10',
      mainContact: 'private@example.test',
      paymentMethod: 'PIX',
      environment: Environment.Local,
      items: [{ productId, quantity }],
    };
  }
  async function checkout(
    payload: ReturnType<typeof body>,
    key = randomUUID(),
  ) {
    const correlation = randomUUID();
    correlations.push(correlation);
    const response = await request(api.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .set('x-correlation-id', correlation)
      .send(payload);
    if (
      response.status === 202 &&
      !orderIds.includes(response.body.orderId as string)
    )
      orderIds.push(response.body.orderId as string);
    return response;
  }
  async function event(orderId: string, attempt = 1): Promise<CheckoutEvent> {
    const [row]: { payload: CheckoutEvent }[] = await database.query(
      'SELECT payload FROM outbox_events WHERE deduplication_key=$1',
      [`${orderId}:attempt:${attempt}`],
    );
    return row!.payload;
  }
  async function stock(id: string) {
    const [row]: { physical_quantity: number; reserved_quantity: number }[] =
      await database.query(
        'SELECT physical_quantity,reserved_quantity FROM stock WHERE product_id=$1',
        [id],
      );
    return row!;
  }
  async function status(id: string) {
    return (
      await request(api.getHttpServer()).get(`/orders/${id}/status`).expect(200)
    ).body as { status: string; processingStatus: string };
  }

  it('completes HTTP → outbox → Kafka → worker and preserves trace context', async () => {
    const id = await product();
    const response = await checkout(body(id));
    expect(response.status).toBe(202);
    expect(response.body.status).toBe(OrderStatus.Pending);
    const orderId = String(response.body.orderId);
    const initiated = await event(orderId);
    expect(initiated.correlation_id).toBe(response.headers['x-correlation-id']);
    expect(initiated.trace_id).toMatch(/^[a-f0-9]{32}$/);
    await worker.get(OutboxRelay).execute();
    await eventually(
      async () =>
        (await status(orderId)).processingStatus === ProcessingStatus.Completed,
    );
    expect(await stock(id)).toEqual({
      physical_quantity: 9,
      reserved_quantity: 0,
    });
    expect((await status(orderId)).status).toBe(OrderStatus.Active);
    const rows: { step: string }[] = await database.query(
      'SELECT step FROM idempotency_log WHERE order_id=$1 AND success',
      [orderId],
    );
    expect(rows).toHaveLength(4);
    await producer.send({
      topic,
      messages: Array.from({ length: 4 }, () => ({
        key: orderId,
        value: JSON.stringify(initiated),
      })),
    });
    // The same handler also receives concurrent duplicate events directly.
    await Promise.all(
      Array.from({ length: 3 }, () =>
        worker.get(ActiveOrderUseCase).execute(initiated),
      ),
    );
    expect(await stock(id)).toEqual({
      physical_quantity: 9,
      reserved_quantity: 0,
    });
  });
  it('strictly prevents overselling across concurrent HTTP transactions', async () => {
    const id = await product(5);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => checkout(body(id))),
    );
    expect(
      responses.filter((response) => response.status === 202),
    ).toHaveLength(5);
    expect(
      responses.filter((response) => response.status === 409),
    ).toHaveLength(15);
    expect(await stock(id)).toEqual({
      physical_quantity: 5,
      reserved_quantity: 5,
    });
  });
  it('serializes simultaneous identical keys and rejects different content', async () => {
    const id = await product();
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => checkout(body(id), key)),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    expect(
      new Set(responses.map((response) => String(response.body.orderId))).size,
    ).toBe(1);
    expect(await stock(id)).toEqual({
      physical_quantity: 10,
      reserved_quantity: 1,
    });
    expect((await checkout(body(id, 2), key)).status).toBe(409);
    const orderId = String(responses[0]!.body.orderId);
    await worker.get(ActiveOrderUseCase).execute(await event(orderId));
    expect((await checkout(body(id), key)).body).toEqual({
      orderId,
      status: OrderStatus.Pending,
    });
  });
  it('rolls back the full cart when any product is unavailable', async () => {
    const available = await product(5),
      empty = await product(0);
    const payload = body(available);
    payload.items.push({ productId: empty, quantity: 1 });
    const key = randomUUID();
    expect((await checkout(payload, key)).status).toBe(409);
    expect(await stock(available)).toEqual({
      physical_quantity: 5,
      reserved_quantity: 0,
    });
    expect(
      await database.query('SELECT id FROM "order" WHERE idempotency_key=$1', [
        key,
      ]),
    ).toHaveLength(0);
  });
  it('releases an expired order once even when cleanup races activation', async () => {
    const id = await product();
    const response = await checkout(body(id));
    const orderId = String(response.body.orderId);
    await database.query(
      "UPDATE stock_reservation SET expires_at=clock_timestamp()-interval '1 second' WHERE order_id=$1",
      [orderId],
    );
    await Promise.all([
      worker.get(ExpireReservationsUseCase).execute(),
      worker.get(ActiveOrderUseCase).execute(await event(orderId)),
    ]);
    await worker.get(ExpireReservationsUseCase).execute();
    expect(await stock(id)).toEqual({
      physical_quantity: 10,
      reserved_quantity: 0,
    });
    expect((await status(orderId)).status).toBe(OrderStatus.Cancelled);
  });
  it('lets valid activation win without releasing already-consumed stock', async () => {
    const id = await product();
    const response = await checkout(body(id));
    const orderId = String(response.body.orderId);
    await worker.get(ActiveOrderUseCase).execute(await event(orderId));
    await database.query(
      "UPDATE stock_reservation SET expires_at=clock_timestamp()-interval '1 second' WHERE order_id=$1",
      [orderId],
    );
    await worker.get(ExpireReservationsUseCase).execute();
    expect(await stock(id)).toEqual({
      physical_quantity: 9,
      reserved_quantity: 0,
    });
    expect((await status(orderId)).status).toBe(OrderStatus.Active);
  });
  it('rolls back stock consumption and its success record if activation fails', async () => {
    const id = await product();
    const response = await checkout(body(id));
    const orderId = String(response.body.orderId);
    const step = jest
      .spyOn(worker.get(ActivateOrderStep), 'exec')
      .mockRejectedValueOnce(new Error('Injected activation failure'));
    try {
      await worker.get(ActiveOrderUseCase).execute(await event(orderId));
    } finally {
      step.mockRestore();
    }
    expect(await stock(id)).toEqual({
      physical_quantity: 10,
      reserved_quantity: 1,
    });
    expect(await status(orderId)).toMatchObject({
      status: OrderStatus.Pending,
      processingStatus: ProcessingStatus.Retrying,
    });
    expect(
      await database.query(
        'SELECT id FROM idempotency_log WHERE order_id=$1 AND success',
        [orderId],
      ),
    ).toHaveLength(0);
    await worker.get(ActiveOrderUseCase).execute(await event(orderId, 2));
    expect(await stock(id)).toEqual({
      physical_quantity: 9,
      reserved_quantity: 0,
    });
  });
  it('resumes after stock consumption without repeating completed steps', async () => {
    const id = await product();
    const response = await checkout(body(id));
    const orderId = String(response.body.orderId);
    worker.get(ConfigService).set('ERP_FAILURES', 1);
    await worker.get(ActiveOrderUseCase).execute(await event(orderId));
    expect(await status(orderId)).toMatchObject({
      status: OrderStatus.Active,
      processingStatus: ProcessingStatus.Retrying,
    });
    const [retry]: { delay: number }[] = await database.query(
      'SELECT extract(epoch FROM available_at-created_at)::float8 AS delay FROM outbox_events WHERE deduplication_key=$1',
      [`${orderId}:attempt:2`],
    );
    expect(retry!.delay).toBeGreaterThanOrEqual(1);
    // A fresh invocation reads persisted progress, as after a worker restart.
    await worker.get(ActiveOrderUseCase).execute(await event(orderId, 2));
    expect((await status(orderId)).processingStatus).toBe(
      ProcessingStatus.Completed,
    );
    expect(await stock(id)).toEqual({
      physical_quantity: 9,
      reserved_quantity: 0,
    });
    expect(
      await database.query(
        'SELECT id FROM idempotency_log WHERE order_id=$1 AND success',
        [orderId],
      ),
    ).toHaveLength(4);
  });
  it('persists bounded retries and a terminal DLQ event without restocking', async () => {
    const id = await product();
    const response = await checkout(body(id));
    const orderId = String(response.body.orderId);
    worker.get(ConfigService).set('ERP_FAILURES', 5);
    for (let attempt = 1; attempt <= 5; attempt++)
      await worker
        .get(ActiveOrderUseCase)
        .execute(await event(orderId, attempt));
    expect(await status(orderId)).toMatchObject({
      status: OrderStatus.Active,
      processingStatus: ProcessingStatus.Failed,
    });
    expect(
      await database.query(
        'SELECT id FROM outbox_events WHERE order_id=$1 AND topic=$2',
        [orderId, `${topic}.dlq`],
      ),
    ).toHaveLength(1);
    expect(await stock(id)).toEqual({
      physical_quantity: 9,
      reserved_quantity: 0,
    });
  });
  it('sends permanent integration failures directly to the outbox DLQ', async () => {
    const id = await product();
    const response = await checkout(body(id));
    const orderId = String(response.body.orderId);
    worker.get(ConfigService).set('SIMULATOR_PERMANENT_FAILURE', 'email');
    await worker.get(ActiveOrderUseCase).execute(await event(orderId));
    expect((await status(orderId)).processingStatus).toBe(
      ProcessingStatus.Failed,
    );
    expect(
      await database.query(
        'SELECT id FROM outbox_events WHERE deduplication_key=$1',
        [`${orderId}:attempt:2`],
      ),
    ).toHaveLength(0);
  });
  it('recovers abandoned publication leases and keeps failed publications pending', async () => {
    const id = await product();
    const response = await checkout(body(id));
    const orderId = String(response.body.orderId);
    await database.query(
      "UPDATE outbox_events SET lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE order_id=$1",
      [orderId, randomUUID()],
    );
    const outbox = worker.get(OutboxRepository);
    const claimed = await outbox.claim();
    const own = claimed.find((entry) => entry.orderId === orderId)!;
    expect(own).toBeDefined();
    // A stale publisher cannot acknowledge a later owner's claim.
    await outbox.acknowledge({ ...own, leaseToken: randomUUID() });
    expect(
      (
        await database.query('SELECT status FROM outbox_events WHERE id=$1', [
          own.id,
        ])
      )[0],
    ).toMatchObject({ status: 'PENDING' });
    for (const entry of claimed) await outbox.release(entry);
    const send = jest
      .spyOn(worker.get(OrderMessaging), 'publish')
      .mockRejectedValue(new Error('Broker offline'));
    try {
      await database.query(
        'UPDATE outbox_events SET available_at=clock_timestamp() WHERE order_id=$1',
        [orderId],
      );
      await worker.get(OutboxRelay).execute();
      expect(
        (
          await database.query(
            'SELECT status FROM outbox_events WHERE order_id=$1',
            [orderId],
          )
        )[0],
      ).toMatchObject({ status: 'PENDING' });
    } finally {
      send.mockRestore();
    }
  });
  it('does not acknowledge invalid messages until the DLQ publish succeeds', async () => {
    const consumer = worker.get(ProcessOrderEventUseCase);
    const send = jest
      .spyOn(worker.get(OrderMessaging), 'publish')
      .mockRejectedValue(new Error('DLQ offline'));
    await expect(
      consumer.handle('{invalid', { topic, partition: 0, offset: '999' }),
    ).rejects.toThrow('DLQ offline');
    send.mockRestore();
    await expect(
      consumer.handle('{invalid', { topic, partition: 0, offset: '999' }),
    ).resolves.toBeUndefined();
  });
  it('accepts checkout and remains API-ready with an unavailable Kafka connection', async () => {
    const check = jest
      .spyOn(api.get(KafkaService), 'checkTopic')
      .mockRejectedValue(new Error('offline'));
    const send = jest
      .spyOn(api.get(KafkaService), 'produce')
      .mockRejectedValue(new Error('offline'));
    try {
      expect((await checkout(body(await product()))).status).toBe(202);
      await request(api.getHttpServer()).get('/health/ready').expect(200);
      expect(send).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
      send.mockRestore();
    }
  });
  it('cold-starts the API and accepts checkout when Kafka and Redis endpoints refuse connections', async () => {
    const { HttpModule } = jest.requireActual<
      typeof import('../../apps/http/src/http.module')
    >('../../apps/http/src/http.module');
    const environment = validateEnvironment(process.env);
    const module = await Test.createTestingModule({ imports: [HttpModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          ...environment,
          KAFKA_BROKERS: ['127.0.0.1:1'],
          REDIS_URL: 'redis://127.0.0.1:1/1',
        }),
      )
      .compile();
    const isolatedApi = module.createNestApplication({ logger: false });
    configureApi(isolatedApi);
    try {
      await isolatedApi.init();
      await request(isolatedApi.getHttpServer())
        .get('/health/ready')
        .expect(200);
      await request(isolatedApi.getHttpServer()).get('/products').expect(200);
      const correlationId = randomUUID();
      correlations.push(correlationId);
      const response = await request(isolatedApi.getHttpServer())
        .post('/checkout')
        .set('Idempotency-Key', randomUUID())
        .set('x-correlation-id', correlationId)
        .send(body(await product()))
        .expect(202);
      const orderId = String(response.body.orderId);
      orderIds.push(orderId);
      expect((await event(orderId)).order_id).toBe(orderId);
      expect(await status(orderId)).toMatchObject({
        status: OrderStatus.Pending,
        processingStatus: ProcessingStatus.Pending,
      });
    } finally {
      await isolatedApi.close();
    }
  });
  it('coalesces misses across two service instances and sets a 300-second TTL', async () => {
    await redis.del([CATALOG_KEY, CATALOG_LOCK]);
    const repository = api.get(ProductRepository),
      lookup = jest.spyOn(repository, 'findAll');
    const second = new GetProducts(
      repository,
      api.get(RedisConnection),
      api.get(Metrics),
      api.get(Spans),
      api.get(AppLogger),
    );
    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 ? second : api.get(GetProducts)).execute(),
        ),
      );
      expect(responses[0]!.length).toBeGreaterThan(0);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(await redis.ttl(CATALOG_KEY)).toBeGreaterThan(0);
      expect(await redis.ttl(CATALOG_KEY)).toBeLessThanOrEqual(300);
      await api.get(GetProducts).execute();
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
    }
  });
  it('recovers a dead cache owner and falls back when Redis is unavailable', async () => {
    await redis.del(CATALOG_KEY);
    await redis.set(CATALOG_LOCK, 'abandoned', { PX: 100 });
    expect((await api.get(GetProducts).execute()).length).toBeGreaterThan(0);
    const connection = api.get(RedisConnection);
    connection.client.destroy();
    expect(
      (await request(api.getHttpServer()).get('/products').expect(200)).body
        .length,
    ).toBeGreaterThan(0);
    await connection.client.connect();
  });
  it('exposes metrics and stores sanitized request audits', async () => {
    await api.get(RequestAuditRepository).beforeApplicationShutdown();
    const rows: { payload: { mainContact: string } }[] = await database.query(
      'SELECT payload FROM request_log WHERE correlation_id=ANY($1::uuid[])',
      [correlations],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((entry) => entry.payload.mainContact === '[redacted]'),
    ).toBe(true);
    expect(
      (await request(api.getHttpServer()).get('/metrics').expect(200)).text,
    ).toContain('shop_checkout_total');
    expect(
      (await request(worker.getHttpServer()).get('/metrics').expect(200)).text,
    ).toContain('shop_processing_total');
    const simulator = worker.get(IntegrationSimulator);
    expect(simulator).toBeDefined();
  });
});
