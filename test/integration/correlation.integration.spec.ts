import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildCheckoutPayload, newIdempotencyKey } from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';
import { createTestApp, TestApp } from './support/test-app';

// The CorrelationMiddleware only honors `x-correlation-id` (a UUID); `x-request-id` is not handled.
describe('Correlation id propagation (integration)', () => {
  let context: TestApp;
  let product: ProductRecord;

  beforeEach(async () => {
    context = await createTestApp();
    product = newProduct();
    context.store.seedProducts([product]);
  });

  afterEach(async () => {
    await context.app.close();
  });

  it('echoes x-correlation-id on GET /products', async () => {
    const correlationId = randomUUID();

    const response = await request(context.app.getHttpServer())
      .get('/products')
      .set('x-correlation-id', correlationId)
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe(correlationId);
  });

  it('echoes x-correlation-id on POST /checkout and GET /orders/:orderId/status', async () => {
    const correlationId = randomUUID();

    const checkout = await request(context.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .set('x-correlation-id', correlationId)
      .send(buildCheckoutPayload(product.id))
      .expect(202);
    const status = await request(context.app.getHttpServer())
      .get(`/orders/${checkout.body.orderId as string}/status`)
      .set('x-correlation-id', correlationId)
      .expect(200);

    expect(checkout.headers['x-correlation-id']).toBe(correlationId);
    expect(status.headers['x-correlation-id']).toBe(correlationId);
    expect(
      [...context.store.orders.values()].map((order) => order.correlationId),
    ).toEqual([correlationId]);
  });
});
