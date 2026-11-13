import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import {
  Environment,
  OrderStatus,
  PaymentType,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { validateEnvironment } from '@app/platform/config/environment';
import { databaseOptions } from '@app/platform/database/options';

const PRODUCT_KEY = 'CASE-LIMITED-001';
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const EXPECTED_STEPS = [
  'ConsumeStockReservationStep',
  'ActivateOrderStep',
  'UpdateErpStep',
  'EmailNotificationStep',
];

interface ProductSnapshot {
  productId: string;
  netPrice: string;
  listPrice: string;
  physical: number;
  reserved: number;
}

interface Acceptance {
  orderId: string;
  status: OrderStatus;
}

interface OrderSnapshot extends Acceptance {
  processingStatus: ProcessingStatus;
  items: {
    productId: string;
    quantity: number;
    netPrice: string;
    listPrice: string;
  }[];
}

async function request<T>(
  url: string,
  expectedStatus = 200,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(
    response.status,
    expectedStatus,
    `${options.method ?? 'GET'} ${url}: expected HTTP ${expectedStatus}, got ${response.status}`,
  );
  return (await response.json()) as T;
}

async function readProduct(database: DataSource): Promise<ProductSnapshot> {
  const rows: ProductSnapshot[] = await database.query(
    `SELECT p.id AS "productId", p.net_price AS "netPrice",
            p.list_price AS "listPrice", s.physical_quantity AS physical,
            s.reserved_quantity AS reserved
       FROM product p JOIN stock s ON s.product_id = p.id
      WHERE p.product_key = $1`,
    [PRODUCT_KEY],
  );
  assert.ok(rows[0], `Product ${PRODUCT_KEY} missing. Run npm run seed:run.`);
  return rows[0];
}

async function waitForCompletion(
  api: string,
  orderId: string,
): Promise<OrderSnapshot> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const order = await request<OrderSnapshot>(
      `${api}/orders/${orderId}/status`,
    );
    assert.equal(order.orderId, orderId, 'Unexpected order returned');
    lastState = `${order.status} / ${order.processingStatus}`;
    assert.notEqual(order.status, OrderStatus.Cancelled, 'Order cancelled');
    assert.notEqual(
      order.processingStatus,
      ProcessingStatus.Failed,
      'Order processing failed',
    );
    if (order.processingStatus === ProcessingStatus.Completed) {
      assert.equal(order.status, OrderStatus.Active);
      return order;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Order ${orderId} did not complete within ${POLL_TIMEOUT_MS / 1000}s (last state: ${lastState}). Check the consumer.`,
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
  await request(`${api}/health/ready`);

  const database = new DataSource(databaseOptions(environment.DATABASE_URL));
  await database.initialize();
  try {
    const before = await readProduct(database);
    assert.equal(before.physical, 1, 'Expected seeded stock of 1 unit');
    assert.equal(before.reserved, 0, 'Expected no existing reservations');

    const purchase: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `happy-path-${randomUUID()}`,
        'x-correlation-id': randomUUID(),
      },
      body: JSON.stringify({
        paymentType: PaymentType.PrePaid,
        dueDate: new Date().toISOString().slice(0, 10),
        mainContact: 'happy-path@example.test',
        paymentMethod: 'PIX',
        environment: Environment.Local,
        items: [{ productId: before.productId, quantity: 1 }],
      }),
    };
    const accepted = await request<Acceptance>(
      `${api}/checkout`,
      202,
      purchase,
    );
    assert.equal(accepted.status, OrderStatus.Pending);
    assert.match(
      accepted.orderId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'Checkout must return an order UUID',
    );
    process.stdout.write(`Checkout accepted: ${accepted.orderId}\n`);

    const order = await waitForCompletion(api, accepted.orderId);
    assert.deepEqual(order.items, [
      {
        productId: before.productId,
        quantity: 1,
        netPrice: before.netPrice,
        listPrice: before.listPrice,
      },
    ]);
    process.stdout.write('Order reached Active / Completed.\n');

    // A replay after completion must preserve the original acceptance response.
    const replay = await request<Acceptance>(`${api}/checkout`, 202, purchase);
    assert.deepEqual(replay, accepted, 'Replay must return the same order');

    const after = await readProduct(database);
    assert.equal(after.physical, 0, 'Expected exactly 1 unit consumed');
    assert.equal(after.reserved, 0, 'Expected no remaining reserved stock');

    const reservations: {
      productId: string;
      quantity: number;
      status: string;
    }[] = await database.query(
      `SELECT product_id AS "productId", quantity, status
           FROM stock_reservation WHERE order_id = $1`,
      [accepted.orderId],
    );
    assert.deepEqual(reservations, [
      { productId: before.productId, quantity: 1, status: 'CONSUMED' },
    ]);

    const steps: { step: string }[] = await database.query(
      'SELECT step FROM idempotency_log WHERE order_id = $1 AND success = true',
      [accepted.orderId],
    );
    assert.deepEqual(
      steps.map(({ step }) => step).sort(),
      [...EXPECTED_STEPS].sort(),
      'Expected exactly one success for each of the four activation steps',
    );
    process.stdout.write(
      'PASSED: checkout completed, stock consumed once, reservation consumed, all four steps succeeded, and replay returned the same order.\n',
    );
  } finally {
    await database.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
