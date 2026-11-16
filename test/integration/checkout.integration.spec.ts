import request from 'supertest';
import { OrderStatus } from '@app/orders/domain/shared/types/order.type';
import { ORDER_CHECKOUT_INITIATED } from '@app/orders/messaging/order-events';
import {
  buildCheckoutPayload,
  newIdempotencyKey,
  UUID_PATTERN,
} from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';
import { CHECKOUT_TOPIC, createTestApp, TestApp } from './support/test-app';

describe('POST /checkout (integration)', () => {
  let testContext: TestApp;
  let product: ProductRecord;

  beforeEach(async () => {
    testContext = await createTestApp();
    product = newProduct({ physicalQuantity: 5 });
    testContext.inMemoryStore.seedProducts([product]);
  });

  afterEach(async () => {
    await testContext.app.close();
  });

  it('accepts a valid checkout for an in-stock product with 202 and a pending order', async () => {
    const response = await request(testContext.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .set('X-Environment', 'Local')
      .send(buildCheckoutPayload(product.id, 2))
      .expect(202);

    expect(response.body).toEqual({
      orderId: expect.stringMatching(UUID_PATTERN),
      status: OrderStatus.Pending,
    });

    const { inMemoryStore: store } = testContext;

    expect(store.orders.get(response.body.orderId)?.status).toBe(
      OrderStatus.Pending,
    );

    expect(store.reservations).toEqual([
      {
        orderId: response.body.orderId,
        productId: product.id,
        quantity: 2,
        status: 'ACTIVE',
      },
    ]);

    expect(store.products.get(product.id)?.reservedQuantity).toBe(2);
    expect(store.outbox).toHaveLength(1);

    expect(store.outbox[0]).toMatchObject({
      orderId: response.body.orderId,
      topic: CHECKOUT_TOPIC,
      status: 'PENDING',
      payload: {
        kind: ORDER_CHECKOUT_INITIATED,
        data: { order_id: response.body.orderId },
        meta: { attempt: 1 },
      },
    });
  });

  it('replays the same Idempotency-Key with the same orderId without creating a second order', async () => {
    const key = newIdempotencyKey();
    const payload = buildCheckoutPayload(product.id, 1);

    const first = await request(testContext.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .set('X-Environment', 'Local')
      .send(payload)
      .expect(202);

    const replay = await request(testContext.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .set('X-Environment', 'Local')
      .send(payload)
      .expect(202);

    expect(replay.body).toEqual(first.body);
    expect(testContext.inMemoryStore.orders.size).toBe(1);
    expect(testContext.inMemoryStore.reservations).toHaveLength(1);
    expect(testContext.inMemoryStore.outbox).toHaveLength(1);

    expect(
      testContext.inMemoryStore.products.get(product.id)?.reservedQuantity,
    ).toBe(1);
  });

  it.each([undefined, 'Staging'])(
    'rejects X-Environment %p with 400 without creating an order',
    async (environment) => {
      const checkoutRequest = request(testContext.app.getHttpServer())
        .post('/checkout')
        .set('Idempotency-Key', newIdempotencyKey());

      if (environment) {

        checkoutRequest.set('X-Environment', environment);

      }

      const response = await checkoutRequest
        .send(buildCheckoutPayload(product.id, 1))
        .expect(400);

      expect(response.body.message).toContain('X-Environment');
      expect(testContext.inMemoryStore.orders.size).toBe(0);
    },
  );

  it('rejects environment in the request body', async () => {
    await request(testContext.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .set('X-Environment', 'Local')
      .send({ ...buildCheckoutPayload(product.id, 1), environment: 'Local' })
      .expect(400);
  });
});
