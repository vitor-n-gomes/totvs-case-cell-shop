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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStock(database: DataSource): Promise<StockSnapshot> {
  const rows: {
    product_id: string;
    physical_quantity: number;
    reserved_quantity: number;
  }[] = await database.query(
    `SELECT p.id AS product_id, s.physical_quantity, s.reserved_quantity
       FROM product p JOIN stock s ON s.product_id = p.id
      WHERE p.product_key = $1`,
    [PRODUCT_KEY],
  );

  const row = rows[0];

  if (!row) {
    throw new Error(
      `Product ${PRODUCT_KEY} not found. Run "npm run seed:run".`,
    );
  }

  return {
    productId: row.product_id,
    physical: row.physical_quantity,
    reserved: row.reserved_quantity,
    available: row.physical_quantity - row.reserved_quantity,
  };
}

async function checkout(
  api: string,
  productId: string,
  request: number,
): Promise<CheckoutOutcome> {
  const response = await fetch(`${api}/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `overselling-${randomUUID()}`,
      'x-correlation-id': randomUUID(),
    },
    body: JSON.stringify({
      paymentType: PaymentType.PrePaid,
      dueDate: new Date().toISOString().slice(0, 10),
      mainContact: `customer-${request}@example.test`,
      paymentMethod: 'PIX',
      environment: Environment.Local,
      items: [{ productId, quantity: 1 }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body: unknown = await response.json().catch(() => ({}));
  const record = (body ?? {}) as { orderId?: string; message?: unknown };

  if (response.status === 202 && record.orderId) {
    return { kind: 'accepted', request, orderId: record.orderId };
  }

  return {
    kind: 'rejected',
    rejection: {
      request,
      status: response.status,
      message: String(record.message ?? response.statusText),
    },
  };
}

async function orderStatus(api: string, orderId: string): Promise<string> {
  const response = await fetch(`${api}/orders/${orderId}/status`, {
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
  api: string,
  orderIds: string[],
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>(
    orderIds.map((id) => [id, OrderStatus.Pending]),
  );

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const [id, status] of statuses) {
      if (status !== OrderStatus.Pending) {
        continue;
      }

      statuses.set(id, await orderStatus(api, id));
    }

    if ([...statuses.values()].every((s) => s !== OrderStatus.Pending)) {
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return statuses;
}

async function main(): Promise<number> {
  const root = resolve(__dirname, '..');

  config({
    path:
      process.env.ENV_FILE ??
      ['.env.local', '.env'].map((f) => resolve(root, f)),
  });

  const environment = validateEnvironment(process.env);
  const api = process.env.API_URL ?? `http://localhost:${environment.API_PORT}`;
  const database = new DataSource(databaseOptions(environment.DATABASE_URL));

  await database.initialize();

  try {
    const before = await readStock(database);

    const health = await fetch(`${api}/health/ready`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);

    if (!health?.ok) {
      process.stderr.write(
        `API is not ready at ${api}. Start the http app and the consumer first.\n`,
      );

      return 1;
    }

    process.stdout.write(
      `Starting stock for ${PRODUCT_KEY}: physical=${before.physical} reserved=${before.reserved} available=${before.available}\n`,
    );

    process.stdout.write(
      `Firing ${REQUESTS} simultaneous POST /checkout requests...\n`,
    );

    const settled = await Promise.allSettled(
      Array.from({ length: REQUESTS }, (_, index) =>
        checkout(api, before.productId, index + 1),
      ),
    );

    const accepted: string[] = [];
    const rejections: Rejection[] = [];

    for (const [index, result] of settled.entries()) {
      if (result.status === 'rejected') {
        rejections.push({
          request: index + 1,
          status: 'network-error',
          message:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      } else if (result.value.kind === 'accepted') {
        accepted.push(result.value.orderId);

        process.stdout.write(
          `  #${result.value.request} 202 Accepted orderId=${result.value.orderId}\n`,
        );
      } else {
        rejections.push(result.value.rejection);
        const { request, status, message } = result.value.rejection;

        process.stdout.write(`  #${request} ${status} rejected: ${message}\n`);
      }
    }

    process.stdout.write(
      `Polling ${accepted.length} accepted order(s) every ${POLL_INTERVAL_MS}ms (timeout ${POLL_TIMEOUT_MS / 1000}s)...\n`,
    );

    const statuses = await waitForTerminalStatus(api, accepted);
    const finalStatuses = [...statuses.values()];
    const active = finalStatuses.filter((s) => s === OrderStatus.Active).length;

    const cancelled = finalStatuses.filter(
      (s) => s === OrderStatus.Cancelled,
    ).length;

    const pending = finalStatuses.filter(
      (s) => s === OrderStatus.Pending,
    ).length;

    const notSold = cancelled + rejections.length;
    const after = await readStock(database);

    const rows: (string | number)[][] = [
      ['Metric', 'Actual', 'Expected'],
      ['Total requests sent', REQUESTS, REQUESTS],
      ['Accepted (202)', accepted.length, '-'],
      ['Orders Active', active, 1],
      ['Orders Cancelled / rejected', notSold, REQUESTS - 1],
      ['Orders stuck Pending', pending, 0],
      ['Final available (physical - reserved)', after.available, 0],
      ['Final physical_quantity', after.physical, 0],
      ['Final reserved_quantity', after.reserved, 0],
    ];

    process.stdout.write(
      `\n${rows
        .map(
          ([label, actual, expected]) =>
            `${String(label).padEnd(40)}${String(actual).padEnd(10)}${expected}`,
        )
        .join('\n')}\n\n`,
    );

    const errors: string[] = [];

    if (pending > 0) {
      errors.push(
        `${pending} order(s) still Pending after ${POLL_TIMEOUT_MS / 1000}s. Is the consumer running?`,
      );
    }

    if (active !== 1) {
      errors.push(`Expected exactly 1 Active order, got ${active}.`);
    }

    if (notSold !== REQUESTS - 1) {
      errors.push(
        `Expected ${REQUESTS - 1} Cancelled/rejected, got ${notSold}.`,
      );
    }

    if (after.available < 0 || after.physical < 0) {
      errors.push(
        `OVERSELLING: negative stock (available=${after.available}).`,
      );
    }

    if (after.available !== 0) {
      errors.push(`Expected available_quantity 0, got ${after.available}.`);
    }

    if (after.reserved !== 0) {
      errors.push(`Expected reserved_quantity 0, got ${after.reserved}.`);
    }

    if (errors.length) {
      process.stderr.write(
        `FAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`,
      );

      return 1;
    }

    process.stdout.write('PASSED: no overselling detected.\n');

    return 0;
  } finally {
    await database.destroy();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exitCode = 1;
  });
