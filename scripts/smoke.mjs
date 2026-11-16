import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:3001';
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

const log = (message) => process.stdout.write(`${message}\n`);

async function request(url, { expectedStatus = 200, ...options } = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const statuses = [expectedStatus].flat();
  assert.ok(
    statuses.includes(response.status),
    `${options.method ?? 'GET'} ${url}: expected HTTP ${statuses.join('/')}, got ${response.status} ${text}`,
  );
  const isJson = response.headers.get('content-type')?.includes('json');
  return { status: response.status, body: isJson ? JSON.parse(text) : text };
}

async function checkReadiness() {
  for (const url of [API_URL, WORKER_URL]) {
    await request(`${url}/health/ready`);
  }
  log('API and worker are ready.');
}

async function listProducts() {
  const { body } = await request(`${API_URL}/products`);
  assert.ok(body.length > 0, 'Catalog is empty. Run npm run seed first.');
  return body;
}

function checkoutRequest(productId) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `smoke-${randomUUID()}`,
    },
    body: JSON.stringify({
      paymentType: 'PrePaid',
      dueDate: new Date().toISOString().slice(0, 10),
      mainContact: 'smoke@example.test',
      paymentMethod: 'PIX',
      environment: 'Local',
      items: [{ productId, quantity: 1 }],
    }),
  };
}

// The catalog does not expose stock, so skip products rejected with 409 (insufficient stock).
async function checkout(products) {
  for (const product of products) {
    const purchase = checkoutRequest(product.id);
    const { status, body } = await request(`${API_URL}/checkout`, {
      ...purchase,
      expectedStatus: [202, 409],
    });
    if (status === 202) {
      assert.equal(body.status, 'Pending');
      log(`Checkout accepted for ${product.productKey}: ${body.orderId}`);
      return { purchase, accepted: body };
    }
  }
  throw new Error('No product has stock left. Run npm run seed first.');
}

async function checkReplay(purchase, accepted) {
  const replay = await request(`${API_URL}/checkout`, {
    ...purchase,
    expectedStatus: 202,
  });
  assert.deepEqual(replay.body, accepted, 'Replay must return the same order');
  log('Idempotent replay returned the same order.');
}

async function waitForCompletion(orderId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const { body: order } = await request(
      `${API_URL}/orders/${orderId}/status`,
    );
    lastState = `${order.status} / ${order.processingStatus}`;
    assert.notEqual(order.status, 'Cancelled', 'Order cancelled');
    assert.notEqual(
      order.processingStatus,
      'Failed',
      'Order processing failed',
    );
    if (order.processingStatus === 'Completed') {
      assert.equal(order.status, 'Active');
      log('Order reached Active / Completed.');
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Order ${orderId} did not complete within ${POLL_TIMEOUT_MS / 1000}s (last state: ${lastState}). Check the consumer.`,
  );
}

async function checkMetrics() {
  for (const url of [API_URL, WORKER_URL]) {
    const { body } = await request(`${url}/metrics`);
    assert.match(body, /shop_/, `${url}/metrics exposes no shop_ metrics`);
  }
  log('API and worker metrics are exposed.');
}

async function main() {
  await checkReadiness();
  const products = await listProducts();
  const { purchase, accepted } = await checkout(products);
  await checkReplay(purchase, accepted);
  await waitForCompletion(accepted.orderId);
  await checkMetrics();
  log(`Container smoke passed: ${accepted.orderId}`);
}

await main().catch((error) => {
  process.stderr.write(
    `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
