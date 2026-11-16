import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '@app/platform/config/environment';
import { databaseOptions } from '@app/platform/database/options';
import {
  Environment,
  OrderStatus,
  PaymentType,
} from '@app/order/domain/shared/types/order.type';

const PRODUCT_KEY = 'CASE-LIMITED-001';
const REQUESTS = 5;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface StockSnapshot {
  productId: string;
  physical: number;
  reserved: number;
  available: number;
}

interface Rejection {
  request: number;
  status: number | string;
  message: string;
}

type CheckoutOutcome =
  | { kind: 'accepted'; request: number; orderId: string }
  | { kind: 'rejected'; rejection: Rejection };

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readStock(dataSource: DataSource): Promise<StockSnapshot> {
  const stockRows: {
    product_id: string;
    physical_quantity: number;
    reserved_quantity: number;
  }[] = await dataSource.query(
    `SELECT p.id AS product_id, s.physical_quantity, s.reserved_quantity
       FROM product p JOIN stock s ON s.product_id = p.id
      WHERE p.product_key = $1`,
    [PRODUCT_KEY],
  );

  const stockRow = stockRows[0];

  if (!stockRow) {

    throw new Error(
      `Product ${PRODUCT_KEY} not found. Run "npm run seed:run".`,
    );

  }

  return {
    productId: stockRow.product_id,
    physical: stockRow.physical_quantity,
    reserved: stockRow.reserved_quantity,
    available: stockRow.physical_quantity - stockRow.reserved_quantity,
  };
}

async function checkout(
  apiBaseUrl: string,
  productId: string,
  requestNumber: number,
): Promise<CheckoutOutcome> {
  const response = await fetch(`${apiBaseUrl}/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `overselling-${randomUUID()}`,
      'x-correlation-id': randomUUID(),
    },
    body: JSON.stringify({
      paymentType: PaymentType.PrePaid,
      dueDate: new Date().toISOString().slice(0, 10),
      mainContact: `customer-${requestNumber}@example.test`,
      paymentMethod: 'PIX',
      environment: Environment.Local,
      items: [{ productId, quantity: 1 }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const responseBody: unknown = await response.json().catch(() => ({}));

  const checkoutResponse = (responseBody ?? {}) as {
    orderId?: string;
    message?: unknown;
  };

  if (response.status === 202 && checkoutResponse.orderId) {

    return {
      kind: 'accepted',
      request: requestNumber,
      orderId: checkoutResponse.orderId,
    };

  }

  return {
    kind: 'rejected',
    rejection: {
      request: requestNumber,
      status: response.status,
      message: String(checkoutResponse.message ?? response.statusText),
    },
  };
}

async function orderStatus(
  apiBaseUrl: string,
  orderId: string,
): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/orders/${orderId}/status`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {

    throw new Error(
      `GET /orders/${orderId}/status returned ${response.status}`,
    );

  }

  return ((await response.json()) as { status: string }).status;
}

// Returns the last known status of every order, even when some never settle.
async function waitForTerminalStatus(
  apiBaseUrl: string,
  orderIds: string[],
): Promise<Map<string, string>> {
  const orderStatuses = new Map<string, string>(
    orderIds.map((orderId) => [orderId, OrderStatus.Pending]),
  );

  const pollDeadlineMs = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < pollDeadlineMs) {

    for (const [orderId, status] of orderStatuses) {

      if (status !== OrderStatus.Pending) {

        continue;

      }

      orderStatuses.set(orderId, await orderStatus(apiBaseUrl, orderId));

    }

    if (
      [...orderStatuses.values()].every(
        (orderStatus) => orderStatus !== OrderStatus.Pending,
      )
    ) {

      break;

    }

    await sleep(POLL_INTERVAL_MS);

  }

  return orderStatuses;
}

async function main(): Promise<number> {
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

  const dataSource = new DataSource(databaseOptions(environment.DATABASE_URL));

  await dataSource.initialize();

  try {

    const initialStock = await readStock(dataSource);

    const readinessResponse = await fetch(`${apiBaseUrl}/health/ready`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);

    if (!readinessResponse?.ok) {

      process.stderr.write(
        `API is not ready at ${apiBaseUrl}. Start the http app and the consumer first.\n`,
      );

      return 1;

    }

    process.stdout.write(
      `Starting stock for ${PRODUCT_KEY}: physical=${initialStock.physical} reserved=${initialStock.reserved} available=${initialStock.available}\n`,
    );

    process.stdout.write(
      `Firing ${REQUESTS} simultaneous POST /checkout requests...\n`,
    );

    const checkoutResults = await Promise.allSettled(
      Array.from({ length: REQUESTS }, (_, index) =>
        checkout(apiBaseUrl, initialStock.productId, index + 1),
      ),
    );

    const acceptedOrderIds: string[] = [];
    const rejections: Rejection[] = [];

    for (const [index, checkoutResult] of checkoutResults.entries()) {

      if (checkoutResult.status === 'rejected') {

        rejections.push({
          request: index + 1,
          status: 'network-error',
          message:
            checkoutResult.reason instanceof Error
              ? checkoutResult.reason.message
              : String(checkoutResult.reason),
        });

      } else if (checkoutResult.value.kind === 'accepted') {

        acceptedOrderIds.push(checkoutResult.value.orderId);

        process.stdout.write(
          `  #${checkoutResult.value.request} 202 Accepted orderId=${checkoutResult.value.orderId}\n`,
        );

      } else {

        rejections.push(checkoutResult.value.rejection);

        const {
          request: requestNumber,
          status,
          message,
        } = checkoutResult.value.rejection;

        process.stdout.write(
          `  #${requestNumber} ${status} rejected: ${message}\n`,
        );

      }

    }

    process.stdout.write(
      `Polling ${acceptedOrderIds.length} accepted order(s) every ${POLL_INTERVAL_MS}ms (timeout ${POLL_TIMEOUT_MS / 1000}s)...\n`,
    );

    const orderStatuses = await waitForTerminalStatus(
      apiBaseUrl,
      acceptedOrderIds,
    );

    const finalStatuses = [...orderStatuses.values()];

    const activeOrderCount = finalStatuses.filter(
      (orderStatus) => orderStatus === OrderStatus.Active,
    ).length;

    const cancelledOrderCount = finalStatuses.filter(
      (orderStatus) => orderStatus === OrderStatus.Cancelled,
    ).length;

    const pendingOrderCount = finalStatuses.filter(
      (orderStatus) => orderStatus === OrderStatus.Pending,
    ).length;

    const unsoldRequestCount = cancelledOrderCount + rejections.length;
    const finalStock = await readStock(dataSource);

    const summaryRows: (string | number)[][] = [
      ['Metric', 'Actual', 'Expected'],
      ['Total requests sent', REQUESTS, REQUESTS],
      ['Accepted (202)', acceptedOrderIds.length, '-'],
      ['Orders Active', activeOrderCount, 1],
      ['Orders Cancelled / rejected', unsoldRequestCount, REQUESTS - 1],
      ['Orders stuck Pending', pendingOrderCount, 0],
      ['Final available (physical - reserved)', finalStock.available, 0],
      ['Final physical_quantity', finalStock.physical, 0],
      ['Final reserved_quantity', finalStock.reserved, 0],
    ];

    process.stdout.write(
      `\n${summaryRows
        .map(
          ([label, actual, expected]) =>
            `${String(label).padEnd(40)}${String(actual).padEnd(10)}${expected}`,
        )
        .join('\n')}\n\n`,
    );

    const validationErrors: string[] = [];

    if (pendingOrderCount > 0) {

      validationErrors.push(
        `${pendingOrderCount} order(s) still Pending after ${POLL_TIMEOUT_MS / 1000}s. Is the consumer running?`,
      );

    }

    if (activeOrderCount !== 1) {

      validationErrors.push(
        `Expected exactly 1 Active order, got ${activeOrderCount}.`,
      );

    }

    if (unsoldRequestCount !== REQUESTS - 1) {

      validationErrors.push(
        `Expected ${REQUESTS - 1} Cancelled/rejected, got ${unsoldRequestCount}.`,
      );

    }

    if (finalStock.available < 0 || finalStock.physical < 0) {

      validationErrors.push(
        `OVERSELLING: negative stock (available=${finalStock.available}).`,
      );

    }

    if (finalStock.available !== 0) {

      validationErrors.push(
        `Expected available_quantity 0, got ${finalStock.available}.`,
      );

    }

    if (finalStock.reserved !== 0) {

      validationErrors.push(
        `Expected reserved_quantity 0, got ${finalStock.reserved}.`,
      );

    }

    if (validationErrors.length) {

      process.stderr.write(
        `FAILED:\n${validationErrors.map((validationError) => `  - ${validationError}`).join('\n')}\n`,
      );

      return 1;

    }

    process.stdout.write('PASSED: no overselling detected.\n');

    return 0;

  } finally {

    await dataSource.destroy();

  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exitCode = 1;
  });
