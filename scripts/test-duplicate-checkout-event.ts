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
  options: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {

    response = await fetch(url, {
      ...options,
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
      `${options.method ?? 'GET'} ${url} failed (${reason}). Start the API with "npm run start:dev" and the consumer with "npm run consumer:debug" in separate terminals. If the API uses another host or port, set API_URL to its HTTP address.`,
      { cause: error },
    );

  }

  assert.equal(
    response.status,
    expectedStatus,
    `${options.method ?? 'GET'} ${url}: expected HTTP ${expectedStatus}, got ${response.status}`,
  );

  return (await response.json()) as T;
}

async function readStock(database: DataSource): Promise<StockSnapshot> {
  const rows: StockSnapshot[] = await database.query(
    `SELECT p.id AS "productId", s.physical_quantity AS physical,
            s.reserved_quantity AS reserved
       FROM product p JOIN stock s ON s.product_id = p.id
      WHERE p.product_key = $1`,
    [PRODUCT_KEY],
  );

  assert.ok(rows[0], `Product ${PRODUCT_KEY} missing. Run npm run seed:run.`);

  return rows[0];
}

async function publishSameEvent(
  producer: Producer,
  topic: string,
  event: CheckoutInitiatedEvent,
  count: number,
): Promise<RecordMetadata[]> {
  const receipts: RecordMetadata[] = [];
  // Keep every field identical, including event_id, attempt and timestamps.
  const value = JSON.stringify(event);

  for (let index = 0; index < count; index++) {

    const published = await producer.send({
      topic,
      acks: -1,
      messages: [{ key: event.data.order_id, value }],
    });

    assert.equal(published.length, 1, 'Expected one Kafka publication receipt');
    receipts.push(...published);

    process.stdout.write(
      `Published same event: event_id=${event.meta.event_id} attempt=${event.meta.attempt} partition=${published[0]!.partition} offset=${published[0]!.baseOffset}\n`,
    );

  }

  return receipts;
}

async function waitForConsumption(
  admin: Admin,
  groupId: string,
  topic: string,
  receipts: RecordMetadata[],
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {

    const offsets = await admin.fetchOffsets({
      groupId,
      topics: [topic],
    });

    // A committed offset is the NEXT message to consume. Waiting for it to
    // pass each receipt proves the application's group handled every replay.
    const consumed = receipts.every((receipt) => {
      assert.ok(
        receipt.baseOffset,
        'Kafka did not return a publication offset',
      );

      const committed = offsets
        .find((entry) => entry.topic === topic)
        ?.partitions.find((entry) => entry.partition === receipt.partition);

      return (
        committed !== undefined &&
        BigInt(committed.offset) > BigInt(receipt.baseOffset)
      );
    });

    if (consumed) {

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
  api: string,
  database: DataSource,
  orderId: string,
  productId: string,
): Promise<void> {
  const order = await request<OrderSnapshot>(`${api}/orders/${orderId}/status`);

  assert.equal(order.orderId, orderId);
  assert.equal(order.status, OrderStatus.Active);
  assert.equal(order.processingStatus, ProcessingStatus.Completed);

  const after = await readStock(database);

  assert.equal(after.physical, 0, 'Expected exactly one unit consumed');
  assert.equal(after.reserved, 0, 'Expected no remaining reserved stock');

  const reservations: {
    productId: string;
    quantity: number;
    status: string;
  }[] = await database.query(
    `SELECT product_id AS "productId", quantity, status
         FROM stock_reservation WHERE order_id = $1`,
    [orderId],
  );

  assert.deepEqual(reservations, [
    { productId, quantity: 1, status: 'CONSUMED' },
  ]);

  const steps: { step: string; success: boolean }[] = await database.query(
    'SELECT step, success FROM idempotency_log WHERE order_id = $1',
    [orderId],
  );

  assert.deepEqual(
    steps.sort((left, right) => left.step.localeCompare(right.step)),
    [...EXPECTED_STEPS].sort().map((step) => ({ step, success: true })),
    'Expected exactly four successful step records and no failed steps',
  );

  const attempts: { lastAttempt: number }[] = await database.query(
    'SELECT last_attempt AS "lastAttempt" FROM "order" WHERE id = $1',
    [orderId],
  );

  assert.deepEqual(
    attempts,
    [{ lastAttempt: 1 }],
    'Replays must not advance attempts',
  );

  const outbox: { deduplicationKey: string }[] = await database.query(
    'SELECT deduplication_key AS "deduplicationKey" FROM outbox_events WHERE order_id = $1',
    [orderId],
  );

  assert.deepEqual(
    outbox,
    [{ deduplicationKey: `${orderId}:attempt:1` }],
    'Expected only the original outbox event, with no retry or DLQ outbox entries',
  );
}

async function main(): Promise<void> {
  const root = resolve(__dirname, '..');

  config({
    path:
      process.env.ENV_FILE ??
      ['.env.local', '.env'].map((file) => resolve(root, file)),
  });

  const environment = validateEnvironment(process.env);
  const api = process.env.API_URL ?? `http://localhost:${environment.API_PORT}`;
  const groupId = `${environment.KAFKA_GROUP_ID}-checkout`;

  await request(`${api}/health/ready`);

  const kafka = new Kafka(kafkaClientOptions(new ConfigService(environment)));
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const admin = kafka.admin();
  const database = new DataSource(databaseOptions(environment.DATABASE_URL));

  try {

    await database.initialize();
    await producer.connect();
    await admin.connect();

    const before = await readStock(database);

    assert.equal(before.physical, 1, 'Expected seeded stock of one unit');
    assert.equal(before.reserved, 0, 'Expected no existing reservations');

    const accepted = await request<{ orderId: string; status: OrderStatus }>(
      `${api}/checkout`,
      202,
      {
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
          items: [{ productId: before.productId, quantity: 1 }],
        }),
      },
    );

    assert.equal(accepted.status, OrderStatus.Pending);
    process.stdout.write(`Checkout accepted: ${accepted.orderId}\n`);

    const rows: { topic: string; payload: unknown }[] = await database.query(
      'SELECT topic, payload FROM outbox_events WHERE deduplication_key = $1',
      [`${accepted.orderId}:attempt:1`],
    );

    assert.equal(rows.length, 1, 'Expected the original checkout outbox event');

    const original = rows[0]!;
    const event = parseOrderEvent(original.payload);

    assert.ok(
      event?.kind === ORDER_CHECKOUT_INITIATED,
      'Invalid checkout event',
    );

    assert.equal(event.data.order_id, accepted.orderId);
    assert.equal(event.meta.attempt, 1);
    assert.equal(original.topic, environment.CHECKOUT_TOPIC);

    process.stdout.write(
      `Publishing ${DUPLICATE_PUBLICATIONS} identical checkout events...\n`,
    );

    const receipts = await publishSameEvent(
      producer,
      original.topic,
      event,
      DUPLICATE_PUBLICATIONS,
    );

    await waitForConsumption(admin, groupId, original.topic, receipts);
    await assertOutcome(api, database, accepted.orderId, before.productId);

    process.stdout.write(
      'Order is Active / Completed; stock consumed once; four successful steps.\n',
    );

    // Exercise a late redelivery after completion as well as the initial burst.
    process.stdout.write(
      'Publishing one more identical event after completion...\n',
    );

    const lateReceipts = await publishSameEvent(
      producer,
      original.topic,
      event,
      1,
    );

    await waitForConsumption(admin, groupId, original.topic, lateReceipts);
    await assertOutcome(api, database, accepted.orderId, before.productId);

    process.stdout.write(
      `PASSED: ${DUPLICATE_PUBLICATIONS + 1} identical Kafka re-publications consumed; order remains Active / Completed, stock consumed once, one consumed reservation, exactly four successful step records, attempt still 1, and no retry/DLQ outbox entries.\n`,
    );

  } finally {

    const cleanup = await Promise.allSettled([
      producer.disconnect(),
      admin.disconnect(),
      ...(database.isInitialized ? [database.destroy()] : []),
    ]);

    for (const result of cleanup) {

      if (result.status === 'rejected') {

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
