import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildCheckoutPayload, newIdempotencyKey } from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';
import { createTestApp, TestApp } from './support/test-app';

// The CorrelationMiddleware only honors `X-Correlation-Id` (a UUID); `x-request-id` is not handled.
describe('Correlation id propagation (integration)', () => {
  let testContext: TestApp;
  let product: ProductRecord;

  beforeEach(async () => {
    testContext = await createTestApp();
    product = newProduct();
    testContext.inMemoryStore.seedProducts([product]);
  });

  afterEach(async () => {
    await testContext.app.close();
  });

  it('echoes X-Correlation-Id on GET /products', async () => {
    const correlationId = randomUUID();

    const response = await request(testContext.app.getHttpServer())
      .get('/products')
      .set('X-Correlation-Id', correlationId)
      .expect(200);

    expect(response.get('X-Correlation-Id')).toBe(correlationId);
  });

  it('echoes X-Correlation-Id on POST /checkout and GET /orders/:orderId/status', async () => {
    const correlationId = randomUUID();

    const checkout = await request(testContext.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .set('X-Environment', 'Local')
      .set('X-Correlation-Id', correlationId)
      .send(buildCheckoutPayload(product.id))
      .expect(202);

    const status = await request(testContext.app.getHttpServer())
      .get(`/orders/${checkout.body.orderId as string}/status`)
      .set('X-Correlation-Id', correlationId)
      .expect(200);

    expect(checkout.get('X-Correlation-Id')).toBe(correlationId);
    expect(status.get('X-Correlation-Id')).toBe(correlationId);

    expect(
      [...testContext.inMemoryStore.orders.values()].map(
        (order) => order.correlationId,
      ),
    ).toEqual([correlationId]);
  });
});
