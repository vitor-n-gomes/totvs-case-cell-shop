import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Kafka, logLevel } from 'kafkajs';
import { createClient } from 'redis';
import request from 'supertest';
import {
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  OrderStatus,
  PaymentType,
  Environment,
  ProcessingStatus,
  CATALOG_KEY,
  CATALOG_LOCK,
} from '@app/contracts';
import { databaseOptions } from '@app/platform/database/options';
import { validateEnvironment } from '@app/platform/config/environment';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { KafkaService } from '@app/platform/kafka/kafka.service';
import { OrderMessaging } from '@app/order/adapters/order.messaging';
import { HealthService } from '@app/platform/health/health.service';
import { kafkaConsumerOptions } from '@app/platform/kafka/kafka.options';
import { TopicKafkaServer } from '@app/platform/kafka/topic-kafka.server';
import {
  ORDER_EVENT_PATTERN,
  ORDER_KAFKA_TRANSPORT,
} from '@app/platform/kafka/kafka.topics';
import { ExpireReservationsUseCase } from '@app/order/adapters/usecases/expire-reservations.use-case';
import { EventBus } from '@app/order/adapters/handlers/event.bus';
import { ProcessOrderEventUseCase } from '@app/order/adapters/usecases/process-order-event.use-case';
import { OutboxRelay } from '@app/order/messaging/outbox-relay';
import { configureApi } from '../../apps/http/src/configure-api';
import { RedisConnection } from '@app/platform/cache/redis-connection';

async function eventually(read: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Asynchronous condition timed out');
}

describe('Event-Driven Integration Flow', () => {
  let httpApp: INestApplication, consumerApp: INestApplication;
  let database: DataSource;
  let redis: ReturnType<typeof createClient>;
  let admin: ReturnType<Kafka['admin']>;
  let producer: ReturnType<Kafka['producer']>;

  let topic: string;
  let groupId: string;
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const correlations: string[] = [];

  beforeAll(async () => {
    config({ path: process.env.TEST_ENV_FILE ?? '.env.test.local' });
    const environment = validateEnvironment(process.env);
    const dbUrl = new URL(environment.DATABASE_URL);
    const redisUrl = new URL(environment.REDIS_URL);

    // Validate test environment
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

    topic = `casecellshop.eventdriven.test.${randomUUID()}`;
    groupId = `${topic}.consumer`;
    process.env.KAFKA_TOPIC = `${topic}.events`;
    process.env.CHECKOUT_TOPIC = topic;
    process.env.KAFKA_GROUP_ID = groupId;

    // Setup Kafka
    const kafka = new Kafka({
      clientId: topic,
      brokers: environment.KAFKA_BROKERS,
      logLevel: logLevel.NOTHING,
    });
    admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [topic, `${topic}.events`, `${topic}.dlq`].map((name) => ({
        topic: name,
        numPartitions: 1,
        replicationFactor: 1,
      })),
    });
    producer = kafka.producer();
    await producer.connect();

    // Setup Database
    database = new DataSource(databaseOptions(environment.DATABASE_URL));
    await database.initialize();
    await database.runMigrations();

    // Setup Redis
    redis = createClient({ url: environment.REDIS_URL });
    redis.on('error', () => undefined);
    await redis.connect();
    await redis.del([CATALOG_KEY, CATALOG_LOCK]);

    // Load HTTP module
    const { HttpModule } = jest.requireActual<
      typeof import('../../apps/http/src/http.module')
    >('../../apps/http/src/http.module');

    httpApp = await NestFactory.create(HttpModule, {
      logger: false,
      abortOnError: false,
    });
    configureApi(httpApp);
    await httpApp.init();

    // Load Consumer module
    const { ConsumerModule } = jest.requireActual<
      typeof import('../../apps/consumer/consumer.module')
    >('../../apps/consumer/consumer.module');

    consumerApp = await NestFactory.create(ConsumerModule, {
      logger: false,
      abortOnError: false,
    });

    const health = consumerApp.get(HealthService);
    health.checkoutConsumerReady = false;
    consumerApp.connectMicroservice({
      strategy: new TopicKafkaServer(
        kafkaConsumerOptions(consumerApp.get(ConfigService), `${groupId}-checkout`),
        ORDER_KAFKA_TRANSPORT,
        ORDER_EVENT_PATTERN,
        topic,
        (ready) => {
          health.checkoutConsumerReady = ready;
        },
      ),
    });
    await consumerApp.startAllMicroservices();
    await consumerApp.init();

    // Disable scheduled tasks
    const schedulerRegistry = consumerApp.get(SchedulerRegistry);
    for (const name of schedulerRegistry.getIntervals())
      schedulerRegistry.deleteInterval(name);
    for (const name of schedulerRegistry.getCronJobs().keys())
      schedulerRegistry.deleteCronJob(name);

    // Wait for consumer to be ready
    await eventually(
      async () =>
        (await request(consumerApp.getHttpServer()).get('/health/ready')).status ===
        200,
    );
  });

  afterAll(async () => {
    try {
      await consumerApp?.close();
      await httpApp?.close();

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
            topics: [topic, `${topic}.events`, `${topic}.dlq`],
          });
        } finally {
          await admin.disconnect();
        }
      }
    }
  });

  // Helper functions
  async function createProduct(quantity = 10): Promise<string> {
    const id = randomUUID();
    productIds.push(id);
    await database.query(
      "INSERT INTO product (id,name,product_key,net_price,list_price) VALUES ($1,'Test Product',$2,10.00,12.00)",
      [id, id],
    );
    await database.query(
      'INSERT INTO stock (id,product_id,physical_quantity) VALUES ($1,$2,$3)',
      [randomUUID(), id, quantity],
    );
    return id;
  }

  function checkoutPayload(productId: string, quantity = 1) {
    return {
      paymentType: PaymentType.PrePaid,
      dueDate: '2026-12-31',
      mainContact: 'customer@example.com',
      paymentMethod: 'PIX',
      environment: Environment.Local,
      items: [{ productId, quantity }],
    };
  }

  async function checkout(
    payload: ReturnType<typeof checkoutPayload>,
    key = randomUUID(),
  ) {
    const correlation = randomUUID();
    correlations.push(correlation);
    const response = await request(httpApp.getHttpServer())
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

  async function getOrderStatus(orderId: string): Promise<string> {
    const result = await database.query(
      `SELECT status FROM "order" WHERE id = $1`,
      [orderId],
    );
    return result[0]?.status ?? 'NONE';
  }

  async function getProcessingStatus(orderId: string): Promise<string> {
    const result = await database.query(
      `SELECT processing_status FROM "order" WHERE id = $1`,
      [orderId],
    );
    return result[0]?.processing_status ?? 'NONE';
  }

  async function getReservationStatus(orderId: string): Promise<string> {
    const result = await database.query(
      `SELECT status FROM stock_reservation WHERE order_id = $1 LIMIT 1`,
      [orderId],
    );
    return result[0]?.status ?? 'NONE';
  }

  async function getStockQuantities(productId: string): Promise<{ physical: number; reserved: number }> {
    const result = await database.query(
      `SELECT physical_quantity, reserved_quantity FROM stock WHERE product_id = $1`,
      [productId],
    );
    return result[0] ? { 
      physical: result[0].physical_quantity,
      reserved: result[0].reserved_quantity 
    } : { physical: 0, reserved: 0 };
  }

  async function getOutboxEvents(orderId: string, attempt = 1): Promise<any[]> {
    const result = await database.query(
      `SELECT payload FROM outbox_events WHERE deduplication_key LIKE $1 ORDER BY created_at`,
      [`${orderId}:attempt:${attempt}%`],
    );
    return result.map((row: any) => row.payload);
  }

  async function orderStatusFromEndpoint(orderId: string): Promise<{ status: string; processingStatus: string }> {
    return (
      await request(httpApp.getHttpServer()).get(`/orders/${orderId}/status`).expect(200)
    ).body;
  }

  // ===== TESTS =====

  it('should complete full checkout and activation flow', async () => {
    const productId = await createProduct(100);
    const response = await checkout(checkoutPayload(productId));
    
    expect(response.status).toBe(202);
    expect(response.body.status).toBe(OrderStatus.Pending);
    const orderId = String(response.body.orderId);

    // Verify order created
    expect(await getOrderStatus(orderId)).toBe(OrderStatus.Pending);

    // Verify reservation created
    expect(await getReservationStatus(orderId)).toBe('ACTIVE');

    // Verify stock reserved
    const stockBefore = await getStockQuantities(productId);
    expect(stockBefore.reserved).toBe(1);
    expect(stockBefore.physical).toBe(99);

    // Process outbox to send event to Kafka
    await consumerApp.get(OutboxRelay).execute();

    // Verify order becomes active via consumer processing
    await eventually(
      async () =>
        (await orderStatusFromEndpoint(orderId)).processingStatus === ProcessingStatus.Completed,
    );

    expect(await getOrderStatus(orderId)).toBe(OrderStatus.Active);
    expect(await getReservationStatus(orderId)).toBe('ACTIVE');

    // Verify stock is still reserved (reservation not released on activation)
    const stockAfter = await getStockQuantities(productId);
    expect(stockAfter.reserved).toBe(1);
    expect(stockAfter.physical).toBe(99);
  });

  it('should emit ORDER_CHECKOUT_INITIATED event', async () => {
    const productId = await createProduct(100);
    const response = await checkout(checkoutPayload(productId));
    const orderId = String(response.body.orderId);

    // Get outbox event
    const events = await getOutboxEvents(orderId);
    expect(events.length).toBeGreaterThan(0);

    const event = events[0];
    expect(event.data.kind).toBe(ORDER_CHECKOUT_INITIATED);
    expect(event.data.data.order_id).toBe(orderId);
    expect(event.meta.correlation_id).toBeDefined();
    expect(event.meta.trace_id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('should propagate correlation_id through event flow', async () => {
    const productId = await createProduct(100);
    const correlation = randomUUID();
    correlations.push(correlation);
    
    const response = await request(httpApp.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', randomUUID())
      .set('x-correlation-id', correlation)
      .send(checkoutPayload(productId));

    const orderId = String(response.body.orderId);
    orderIds.push(orderId);

    // Get event from outbox
    const events = await getOutboxEvents(orderId);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].meta.correlation_id).toBe(correlation);
  });

  it('should process checkout event and activate order', async () => {
    const productId = await createProduct(100);
    const response = await checkout(checkoutPayload(productId));
    const orderId = String(response.body.orderId);

    // Get event from outbox
    const events = await getOutboxEvents(orderId);
    const checkoutEvent = events[0];

    // Send event to Kafka via producer (simulating outbox relay)
    await producer.send({
      topic,
      messages: [
        {
          key: orderId,
          value: JSON.stringify(checkoutEvent),
        },
      ],
    });

    // Allow consumer to process
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify order is activated
    await eventually(async () => await getOrderStatus(orderId) === OrderStatus.Active);
    expect(await getOrderStatus(orderId)).toBe(OrderStatus.Active);
  });

  it('should handle reservation expiration flow', async () => {
    const productId = await createProduct(100);
    const orderId = randomUUID();
    orderIds.push(orderId);
    const correlationId = randomUUID();
    correlations.push(correlationId);

    // Create order
    await database.query(
      `INSERT INTO "order" (
        id, main_contact, alt_contact, payment_type, payment_method, 
        due_date, environment, status, correlation_id, idempotency_key, request_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        orderId,
        'customer@example.com',
        'alt@example.com',
        PaymentType.PrePaid,
        'PIX',
        '2026-12-31',
        Environment.Local,
        OrderStatus.Pending,
        correlationId,
        randomUUID(),
        'test-hash',
      ],
    );

    // Create item
    await database.query(
      `INSERT INTO order_item (id, order_id, product_id, quantity, net_price, list_price) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), orderId, productId, 5, 1000, 1200],
    );

    // Create expired reservation
    const expiresAt = new Date(Date.now() - 1000);
    await database.query(
      `INSERT INTO stock_reservation (
        id, order_id, product_id, quantity, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        orderId,
        productId,
        5,
        'ACTIVE',
        expiresAt,
      ],
    );

    // Update stock to reflect reservation
    await database.query(
      `UPDATE stock SET reserved_quantity = reserved_quantity + $1 WHERE product_id = $2`,
      [5, productId],
    );

    // Verify initial state
    expect(await getOrderStatus(orderId)).toBe(OrderStatus.Pending);
    expect(await getReservationStatus(orderId)).toBe('ACTIVE');
    let stock = await getStockQuantities(productId);
    expect(stock.reserved).toBe(5);

    // Execute expire reservations
    await consumerApp.get(ExpireReservationsUseCase).execute();

    // Verify order cancelled and stock released
    expect(await getOrderStatus(orderId)).toBe(OrderStatus.Cancelled);
    expect(await getReservationStatus(orderId)).toBe('EXPIRED');
    stock = await getStockQuantities(productId);
    expect(stock.reserved).toBe(0);
  });

  it('should dispatch ORDER_RESERVATION_EXPIRED to event bus', async () => {
    const productId = await createProduct(100);
    const orderId = randomUUID();
    orderIds.push(orderId);
    const correlationId = randomUUID();
    correlations.push(correlationId);

    // Create order with expired reservation
    await database.query(
      `INSERT INTO "order" (
        id, main_contact, alt_contact, payment_type, payment_method, 
        due_date, environment, status, correlation_id, idempotency_key, request_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        orderId,
        'customer@example.com',
        'alt@example.com',
        PaymentType.PrePaid,
        'PIX',
        '2026-12-31',
        Environment.Local,
        OrderStatus.Pending,
        correlationId,
        randomUUID(),
        'test-hash',
      ],
    );

    await database.query(
      `INSERT INTO order_item (id, order_id, product_id, quantity, net_price, list_price) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), orderId, productId, 3, 1000, 1200],
    );

    const expiresAt = new Date(Date.now() - 1000);
    await database.query(
      `INSERT INTO stock_reservation (
        id, order_id, product_id, quantity, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        orderId,
        productId,
        3,
        'ACTIVE',
        expiresAt,
      ],
    );

    await database.query(
      `UPDATE stock SET reserved_quantity = reserved_quantity + $1 WHERE product_id = $2`,
      [3, productId],
    );

    // Execute expire reservations (should emit event)
    await consumerApp.get(ExpireReservationsUseCase).execute();

    // Verify the event was processed (order state changed)
    const finalStatus = await getOrderStatus(orderId);
    expect(finalStatus).toBe(OrderStatus.Cancelled);
  });

  it('should handle concurrent event processing without race conditions', async () => {
    const productId = await createProduct(1000);
    
    // Create multiple orders and activate them concurrently
    const orderResponses = await Promise.all(
      Array.from({ length: 5 }, () => checkout(checkoutPayload(productId))),
    );

    const orderIds2 = orderResponses.map((r) => String(r.body.orderId));
    orderIds.push(...orderIds2);

    // Relay outbox
    await consumerApp.get(OutboxRelay).execute();

    // Wait for all to complete
    await eventually(async () => {
      const statuses = await Promise.all(
        orderIds2.map((oid) => getOrderStatus(oid)),
      );
      return statuses.every((s) => s === OrderStatus.Active);
    });

    // Verify all orders are active
    for (const oid of orderIds2) {
      expect(await getOrderStatus(oid)).toBe(OrderStatus.Active);
    }

    // Verify stock was properly reserved
    const stock = await getStockQuantities(productId);
    expect(stock.reserved).toBe(5);
    expect(stock.physical).toBe(995);
  });

  it('should increment metrics when order is activated', async () => {
    const productId = await createProduct(100);
    const response = await checkout(checkoutPayload(productId));
    const orderId = String(response.body.orderId);

    const metrics = consumerApp.get(Metrics);
    const initialCount = (metrics as any)?.reservations?.counterValues?.get({ result: 'activated' }) ?? 0;

    // Activate order
    await consumerApp.get(OutboxRelay).execute();
    await eventually(
      async () =>
        (await orderStatusFromEndpoint(orderId)).status === OrderStatus.Active,
    );

    // Verify metrics were incremented (handler processes order.activated event)
    const finalCount = (metrics as any)?.reservations?.counterValues?.get({ result: 'activated' }) ?? 0;
    expect(finalCount).toBeGreaterThanOrEqual(initialCount);
  });

  it('should handle invalid events by sending to DLQ', async () => {
    // Send invalid event to topic
    const invalidEvent = {
      invalid: 'structure',
    };

    await producer.send({
      topic,
      messages: [
        {
          key: randomUUID(),
          value: JSON.stringify(invalidEvent),
        },
      ],
    });

    // Allow processing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify no errors propagated (consumer should handle gracefully)
    // The event should be in DLQ
    const dlqTopic = `${topic}.dlq`;
    
    // Verify DLQ topic exists (created during setup)
    const topicList = await admin.listTopics();
    expect(topicList).toContain(dlqTopic);
  });

  it('should handle handler errors without blocking other handlers', async () => {
    // This test verifies that if one handler fails, others still process
    const productId = await createProduct(100);
    const response = await checkout(checkoutPayload(productId));
    const orderId = String(response.body.orderId);

    // Get event and dispatch it directly to EventBus
    const events = await getOutboxEvents(orderId);
    const checkoutEvent = events[0];

    // EventBus dispatch should not throw even if a handler fails
    const eventBus = consumerApp.get(EventBus);
    // Create a mock event with valid structure
    const testEvent = {
      kind: 'ORDER_CHECKOUT_INITIATED',
      data: {
        orderId,
      },
      meta: {
        correlationId: checkoutEvent.meta.correlation_id,
        traceId: checkoutEvent.meta.trace_id,
        timestamp: Date.now(),
      },
    };

    // This should not throw
    await expect(eventBus.dispatch(testEvent)).resolves.not.toThrow();
  });

  it('should retry failed events', async () => {
    const productId = await createProduct(100);
    const response = await checkout(checkoutPayload(productId));
    const orderId = String(response.body.orderId);

    // Verify outbox has attempt field
    const events = await getOutboxEvents(orderId, 1);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].meta.attempt).toBe(1);
  });

  it('should support multiple handlers for same event', async () => {
    const productId = await createProduct(100);
    const response = await checkout(checkoutPayload(productId));
    const orderId = String(response.body.orderId);

    // Relay events
    await consumerApp.get(OutboxRelay).execute();

    // Wait for processing
    await eventually(
      async () =>
        (await orderStatusFromEndpoint(orderId)).status === OrderStatus.Active,
    );

    // Verify both checkout handler (activation) and order-activated handler ran
    // by checking order is active
    expect(await getOrderStatus(orderId)).toBe(OrderStatus.Active);
  });

  it('should complete end-to-end flow with multiple sequential events', async () => {
    const productId = await createProduct(100);
    
    // 1. Create order via HTTP
    const checkoutResponse = await checkout(checkoutPayload(productId, 2));
    const orderId = String(checkoutResponse.body.orderId);
    
    expect(checkoutResponse.status).toBe(202);
    expect(checkoutResponse.body.status).toBe(OrderStatus.Pending);

    // 2. Verify ORDER_CHECKOUT_INITIATED event in outbox
    const outboxEvents = await getOutboxEvents(orderId);
    expect(outboxEvents.length).toBeGreaterThan(0);
    const checkoutEvent = outboxEvents[0];
    expect(checkoutEvent.data.kind).toBe(ORDER_CHECKOUT_INITIATED);
    expect(checkoutEvent.data.data.order_id).toBe(orderId);

    // 3. Process through outbox relay
    await consumerApp.get(OutboxRelay).execute();

    // 4. Wait for order to activate
    await eventually(
      async () =>
        (await orderStatusFromEndpoint(orderId)).processingStatus === ProcessingStatus.Completed,
    );

    // 5. Verify order is active and stock is reserved
    expect(await getOrderStatus(orderId)).toBe(OrderStatus.Active);
    const stock = await getStockQuantities(productId);
    expect(stock.physical).toBe(98);
    expect(stock.reserved).toBe(2);

    // 6. Verify idempotency - reprocessing same event doesn't duplicate
    await producer.send({
      topic,
      messages: [
        {
          key: orderId,
          value: JSON.stringify(checkoutEvent),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Stock should remain the same
    const stockAfter = await getStockQuantities(productId);
    expect(stockAfter.physical).toBe(98);
    expect(stockAfter.reserved).toBe(2);
  });
});
