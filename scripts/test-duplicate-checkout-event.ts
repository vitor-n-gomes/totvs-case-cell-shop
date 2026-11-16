import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { Admin, Kafka, Producer, RecordMetadata } from 'kafkajs';
import { DataSource } from 'typeorm';
import {
  Environment,
  OrderStatus,
  PaymentType,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import {
  CheckoutInitiatedEvent,
  ORDER_CHECKOUT_INITIATED,
  parseOrderEvent,
} from '@app/order/messaging/order-events';
import { validateEnvironment } from '@app/platform/config/environment';
import { databaseOptions } from '@app/platform/database/options';
import { kafkaClientOptions } from '@app/platform/kafka/kafka.options';

const PRODUCT_KEY = 'CASE-LIMITED-001';
const DUPLICATE_PUBLICATIONS = 3;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const EXPECTED_STEPS = [
  'ConsumeStockReservationStep',
  'ActivateOrderStep',
  'UpdateErpStep',
  'EmailNotificationStep',
];

interface StockSnapshot {
  productId: string;
  physical: number;
  reserved: number;
}

interface OrderSnapshot {
  orderId: string;
  status: OrderStatus;
  processingStatus: ProcessingStatus;
}

async function request<T>(
  url: string,
  expectedStatus = 200,
  requestOptions: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {

    response = await fetch(url, {
      ...requestOptions,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  } catch (error) {

    const cause = error instanceof Error ? error.cause : undefined;

    const reason =
      cause instanceof Error && 'code' in cause
        ? String(cause.code)
        : error instanceof Error
          ? error.message
          : String(error);

    throw new Error(
      `${requestOptions.method ?? 'GET'} ${url} failed (${reason}). Start the API with "npm run start:dev" and the consumer with "npm run consumer:debug" in separate terminals. If the API uses another host or port, set API_URL to its HTTP address.`,
      { cause: error },
    );

  }

  assert.equal(
    response.status,
    expectedStatus,
    `${requestOptions.method ?? 'GET'} ${url}: expected HTTP ${expectedStatus}, got ${response.status}`,
  );

  return (await response.json()) as T;
}

async function readStock(dataSource: DataSource): Promise<StockSnapshot> {
  const stockRows: StockSnapshot[] = await dataSource.query(
    `SELECT p.id AS "productId", s.physical_quantity AS physical,
            s.reserved_quantity AS reserved
       FROM product p JOIN stock s ON s.product_id = p.id
      WHERE p.product_key = $1`,
    [PRODUCT_KEY],
  );

  assert.ok(
    stockRows[0],
    `Product ${PRODUCT_KEY} missing. Run npm run seed:run.`,
  );

  return stockRows[0];
}

async function publishSameEvent(
  kafkaProducer: Producer,
  topic: string,
  event: CheckoutInitiatedEvent,
  publicationCount: number,
): Promise<RecordMetadata[]> {
  const publicationReceipts: RecordMetadata[] = [];
  // Keep every field identical, including event_id, attempt and timestamps.
  const serializedEvent = JSON.stringify(event);

  for (let index = 0; index < publicationCount; index++) {

    const sendReceipts = await kafkaProducer.send({
      topic,
      acks: -1,
      messages: [{ key: event.data.order_id, value: serializedEvent }],
    });

    assert.equal(
      sendReceipts.length,
      1,
      'Expected one Kafka publication receipt',
    );

    publicationReceipts.push(...sendReceipts);

    process.stdout.write(
      `Published same event: event_id=${event.meta.event_id} attempt=${event.meta.attempt} partition=${sendReceipts[0]!.partition} offset=${sendReceipts[0]!.baseOffset}\n`,
    );

  }

  return publicationReceipts;
}

async function waitForConsumption(
  kafkaAdmin: Admin,
  groupId: string,
  topic: string,
  publicationReceipts: RecordMetadata[],
): Promise<void> {
  const pollDeadlineMs = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < pollDeadlineMs) {

    const consumerOffsets = await kafkaAdmin.fetchOffsets({
      groupId,
      topics: [topic],
    });

    // A committed offset is the NEXT message to consume. Waiting for it to
    // pass each receipt proves the application's group handled every replay.
    const hasConsumedAllPublications = publicationReceipts.every((receipt) => {
      assert.ok(
        receipt.baseOffset,
        'Kafka did not return a publication offset',
      );

      const committedPartitionOffset = consumerOffsets
        .find((offsetEntry) => offsetEntry.topic === topic)
        ?.partitions.find(
          (offsetEntry) => offsetEntry.partition === receipt.partition,
        );

      return (
        committedPartitionOffset !== undefined &&
        BigInt(committedPartitionOffset.offset) > BigInt(receipt.baseOffset)
      );
    });

    if (hasConsumedAllPublications) {

      process.stdout.write(
        `Consumer group ${groupId} passed every replay offset.\n`,
      );

      return;

    }

    await sleep(POLL_INTERVAL_MS);

  }

  throw new Error(
    `Consumer group ${groupId} did not commit past every replay within ${POLL_TIMEOUT_MS / 1000}s. Check the consumer and KAFKA_GROUP_ID.`,
  );
}

async function assertOutcome(
  apiBaseUrl: string,
  dataSource: DataSource,
  orderId: string,
  productId: string,
): Promise<void> {
  const order = await request<OrderSnapshot>(
    `${apiBaseUrl}/orders/${orderId}/status`,
  );

  assert.equal(order.orderId, orderId);
  assert.equal(order.status, OrderStatus.Active);
  assert.equal(order.processingStatus, ProcessingStatus.Completed);

  const finalStock = await readStock(dataSource);

  assert.equal(finalStock.physical, 0, 'Expected exactly one unit consumed');
  assert.equal(finalStock.reserved, 0, 'Expected no remaining reserved stock');

  const reservationRows: {
    productId: string;
    quantity: number;
    status: string;
  }[] = await dataSource.query(
    `SELECT product_id AS "productId", quantity, status
         FROM stock_reservation WHERE order_id = $1`,
    [orderId],
  );

  assert.deepEqual(reservationRows, [
    { productId, quantity: 1, status: 'CONSUMED' },
  ]);

  const activationStepRows: { step: string; success: boolean }[] =
    await dataSource.query(
      'SELECT step, success FROM idempotency_log WHERE order_id = $1',
      [orderId],
    );

  assert.deepEqual(
    activationStepRows.sort((left, right) =>
      left.step.localeCompare(right.step),
    ),
    [...EXPECTED_STEPS].sort().map((step) => ({ step, success: true })),
    'Expected exactly four successful step records and no failed steps',
  );

  const orderAttemptRows: { lastAttempt: number }[] = await dataSource.query(
    'SELECT last_attempt AS "lastAttempt" FROM "order" WHERE id = $1',
    [orderId],
  );

  assert.deepEqual(
    orderAttemptRows,
    [{ lastAttempt: 1 }],
    'Replays must not advance attempts',
  );

  const outboxRows: { deduplicationKey: string }[] = await dataSource.query(
    'SELECT deduplication_key AS "deduplicationKey" FROM outbox_events WHERE order_id = $1',
    [orderId],
  );

  assert.deepEqual(
    outboxRows,
    [{ deduplicationKey: `${orderId}:attempt:1` }],
    'Expected only the original outbox event, with no retry or DLQ outbox entries',
  );
}

async function main(): Promise<void> {
  const projectRoot = resolve(__dirname, '..');

  config({
    path:
      process.env.ENV_FILE ??
      ['.env.local', '.env'].map((environmentFile) =>
        resolve(projectRoot, environmentFile),
      ),
  });

  const environment = validateEnvironment(process.env);

  const apiBaseUrl =
    process.env.API_URL ?? `http://localhost:${environment.API_PORT}`;

  const groupId = `${environment.KAFKA_GROUP_ID}-checkout`;

  await request(`${apiBaseUrl}/health/ready`);

  const kafkaClient = new Kafka(
    kafkaClientOptions(new ConfigService(environment)),
  );

  const kafkaProducer = kafkaClient.producer({ allowAutoTopicCreation: false });
  const kafkaAdmin = kafkaClient.admin();
  const dataSource = new DataSource(databaseOptions(environment.DATABASE_URL));

  try {

    await dataSource.initialize();
    await kafkaProducer.connect();
    await kafkaAdmin.connect();

    const initialStock = await readStock(dataSource);

    assert.equal(initialStock.physical, 1, 'Expected seeded stock of one unit');
    assert.equal(initialStock.reserved, 0, 'Expected no existing reservations');

    const checkoutAcceptance = await request<{
      orderId: string;
      status: OrderStatus;
    }>(`${apiBaseUrl}/checkout`, 202, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `duplicate-event-${randomUUID()}`,
        'x-correlation-id': randomUUID(),
      },
      body: JSON.stringify({
        paymentType: PaymentType.PrePaid,
        dueDate: new Date().toISOString().slice(0, 10),
        mainContact: 'duplicate-event@example.test',
        paymentMethod: 'PIX',
        environment: Environment.Local,
        items: [{ productId: initialStock.productId, quantity: 1 }],
      }),
    });

    assert.equal(checkoutAcceptance.status, OrderStatus.Pending);
    process.stdout.write(`Checkout accepted: ${checkoutAcceptance.orderId}\n`);

    const outboxEventRows: { topic: string; payload: unknown }[] =
      await dataSource.query(
        'SELECT topic, payload FROM outbox_events WHERE deduplication_key = $1',
        [`${checkoutAcceptance.orderId}:attempt:1`],
      );

    assert.equal(
      outboxEventRows.length,
      1,
      'Expected the original checkout outbox event',
    );

    const originalOutboxEvent = outboxEventRows[0]!;
    const event = parseOrderEvent(originalOutboxEvent.payload);

    assert.ok(
      event?.kind === ORDER_CHECKOUT_INITIATED,
      'Invalid checkout event',
    );

    assert.equal(event.data.order_id, checkoutAcceptance.orderId);
    assert.equal(event.meta.attempt, 1);
    assert.equal(originalOutboxEvent.topic, environment.CHECKOUT_TOPIC);

    process.stdout.write(
      `Publishing ${DUPLICATE_PUBLICATIONS} identical checkout events...\n`,
    );

    const publicationReceipts = await publishSameEvent(
      kafkaProducer,
      originalOutboxEvent.topic,
      event,
      DUPLICATE_PUBLICATIONS,
    );

    await waitForConsumption(
      kafkaAdmin,
      groupId,
      originalOutboxEvent.topic,
      publicationReceipts,
    );

    await assertOutcome(
      apiBaseUrl,
      dataSource,
      checkoutAcceptance.orderId,
      initialStock.productId,
    );

    process.stdout.write(
      'Order is Active / Completed; stock consumed once; four successful steps.\n',
    );

    // Exercise a late redelivery after completion as well as the initial burst.
    process.stdout.write(
      'Publishing one more identical event after completion...\n',
    );

    const latePublicationReceipts = await publishSameEvent(
      kafkaProducer,
      originalOutboxEvent.topic,
      event,
      1,
    );

    await waitForConsumption(
      kafkaAdmin,
      groupId,
      originalOutboxEvent.topic,
      latePublicationReceipts,
    );

    await assertOutcome(
      apiBaseUrl,
      dataSource,
      checkoutAcceptance.orderId,
      initialStock.productId,
    );

    process.stdout.write(
      `PASSED: ${DUPLICATE_PUBLICATIONS + 1} identical Kafka re-publications consumed; order remains Active / Completed, stock consumed once, one consumed reservation, exactly four successful step records, attempt still 1, and no retry/DLQ outbox entries.\n`,
    );

  } finally {

    const cleanupResults = await Promise.allSettled([
      kafkaProducer.disconnect(),
      kafkaAdmin.disconnect(),
      ...(dataSource.isInitialized ? [dataSource.destroy()] : []),
    ]);

    for (const cleanupResult of cleanupResults) {

      if (cleanupResult.status === 'rejected') {

        process.stderr.write('FAILED: could not close a test connection.\n');
        process.exitCode = 1;

      }

    }

  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );

  process.exitCode = 1;
});
