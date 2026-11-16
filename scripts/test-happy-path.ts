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
} from '../libs/orders/src/domain/shared/types/order.type';
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
  netPrice: number;
  listPrice: number;
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
    netPrice: number;
    listPrice: number;
  }[];
}

async function request<T>(
  url: string,
  expectedStatus = 200,
  requestOptions: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...requestOptions,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  assert.equal(
    response.status,
    expectedStatus,
    `${requestOptions.method ?? 'GET'} ${url}: expected HTTP ${expectedStatus}, got ${response.status}`,
  );

  return (await response.json()) as T;
}

async function readProduct(dataSource: DataSource): Promise<ProductSnapshot> {
  const productRows: ProductSnapshot[] = await dataSource.query(
    `SELECT p.id AS "productId", p.net_price AS "netPrice",
            p.list_price AS "listPrice", s.physical_quantity AS physical,
            s.reserved_quantity AS reserved
       FROM product p JOIN stock s ON s.product_id = p.id
      WHERE p.product_key = $1`,
    [PRODUCT_KEY],
  );

  assert.ok(
    productRows[0],
    `Product ${PRODUCT_KEY} missing. Run npm run seed:run.`,
  );

  return productRows[0];
}

async function waitForCompletion(
  apiBaseUrl: string,
  orderId: string,
): Promise<OrderSnapshot> {
  const pollDeadlineMs = Date.now() + POLL_TIMEOUT_MS;
  let lastState = 'unknown';

  while (Date.now() < pollDeadlineMs) {

    const order = await request<OrderSnapshot>(
      `${apiBaseUrl}/orders/${orderId}/status`,
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

  await request(`${apiBaseUrl}/health/ready`);

  const dataSource = new DataSource(databaseOptions(environment.DATABASE_URL));

  await dataSource.initialize();

  try {

    const initialStock = await readProduct(dataSource);

    assert.equal(initialStock.physical, 1, 'Expected seeded stock of 1 unit');
    assert.equal(initialStock.reserved, 0, 'Expected no existing reservations');

    const checkoutRequestOptions: RequestInit = {
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
        items: [{ productId: initialStock.productId, quantity: 1 }],
      }),
    };

    const checkoutAcceptance = await request<Acceptance>(
      `${apiBaseUrl}/checkout`,
      202,
      checkoutRequestOptions,
    );

    assert.equal(checkoutAcceptance.status, OrderStatus.Pending);

    assert.match(
      checkoutAcceptance.orderId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'Checkout must return an order UUID',
    );

    process.stdout.write(`Checkout accepted: ${checkoutAcceptance.orderId}\n`);

    const order = await waitForCompletion(
      apiBaseUrl,
      checkoutAcceptance.orderId,
    );

    assert.deepEqual(order.items, [
      {
        productId: initialStock.productId,
        quantity: 1,
        netPrice: initialStock.netPrice,
        listPrice: initialStock.listPrice,
      },
    ]);

    process.stdout.write('Order reached Active / Completed.\n');

    // A replay after completion must preserve the original acceptance response.
    const replayAcceptance = await request<Acceptance>(
      `${apiBaseUrl}/checkout`,
      202,
      checkoutRequestOptions,
    );

    assert.deepEqual(
      replayAcceptance,
      checkoutAcceptance,
      'Replay must return the same order',
    );

    const finalStock = await readProduct(dataSource);

    assert.equal(finalStock.physical, 0, 'Expected exactly 1 unit consumed');

    assert.equal(
      finalStock.reserved,
      0,
      'Expected no remaining reserved stock',
    );

    const reservationRows: {
      productId: string;
      quantity: number;
      status: string;
    }[] = await dataSource.query(
      `SELECT product_id AS "productId", quantity, status
           FROM stock_reservation WHERE order_id = $1`,
      [checkoutAcceptance.orderId],
    );

    assert.deepEqual(reservationRows, [
      { productId: initialStock.productId, quantity: 1, status: 'CONSUMED' },
    ]);

    const successfulStepRows: { step: string }[] = await dataSource.query(
      'SELECT step FROM idempotency_log WHERE order_id = $1 AND success = true',
      [checkoutAcceptance.orderId],
    );

    assert.deepEqual(
      successfulStepRows.map(({ step }) => step).sort(),
      [...EXPECTED_STEPS].sort(),
      'Expected exactly one success for each of the four activation steps',
    );

    process.stdout.write(
      'PASSED: checkout completed, stock consumed once, reservation consumed, all four steps succeeded, and replay returned the same order.\n',
    );

  } finally {

    await dataSource.destroy();

  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );

  process.exitCode = 1;
});
