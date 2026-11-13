import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const api = process.env.API_URL ?? 'http://localhost:3000';
const worker = process.env.WORKER_URL ?? 'http://localhost:3001';
const json = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, `HTTP ${response.status} at ${url}`);
  return { status: response.status, body: await response.json() };
};
await json(`${api}/health/ready`);
await json(`${worker}/health/ready`);
const products = await json(`${api}/products`);
assert.ok(products.body.length > 0, 'Run npm run seed before smoke testing');
const purchase = {
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
    items: [{ productId: products.body[0].id, quantity: 1 }],
  }),
};
const accepted = await json(`${api}/checkout`, purchase);
assert.equal(accepted.status, 202);
assert.deepEqual((await json(`${api}/checkout`, purchase)).body, accepted.body);
const deadline = Date.now() + 30000;
let completed = false;
while (Date.now() < deadline) {
  const result = await json(`${api}/orders/${accepted.body.orderId}/status`);
  if (result.body.processingStatus === 'Completed') {
    assert.equal(result.body.status, 'Active');
    completed = true;
    break;
  }
  assert.notEqual(result.body.processingStatus, 'Failed');
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(completed, 'Order did not complete before the deadline');
for (const url of [api, worker]) {
  const metrics = await fetch(`${url}/metrics`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /shop_/);
}
process.stdout.write(`Container smoke passed: ${accepted.body.orderId}\n`);
