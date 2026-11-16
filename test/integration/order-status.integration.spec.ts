import request from 'supertest';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { buildCheckoutPayload, newIdempotencyKey } from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';
import { createTestApp, TestApp } from './support/test-app';
import { simulateWorkerProcessing } from './support/worker-simulator';

describe('GET /orders/:orderId/status (integration)', () => {
  let context: TestApp;
  let product: ProductRecord;

  async function createOrder(): Promise<string> {
    const response = await request(context.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .send(buildCheckoutPayload(product.id, 1))
      .expect(202);

    return response.body.orderId as string;
  }

  beforeEach(async () => {
    context = await createTestApp();
    product = newProduct({ physicalQuantity: 3, netPrice: 2990 });
    context.store.seedProducts([product]);
  });

  afterEach(async () => {
    await context.app.close();
  });

  it('returns the status of a freshly created order', async () => {
    const orderId = await createOrder();

    const response = await request(context.app.getHttpServer())
      .get(`/orders/${orderId}/status`)
      .expect(200);

    expect(response.body).toMatchObject({
      orderId,
      status: OrderStatus.Pending,
      processingStatus: ProcessingStatus.Pending,
      paymentMethod: 'PIX',
      items: [
        {
          productId: product.id,
          quantity: 1,
          netPrice: product.netPrice,
          listPrice: product.listPrice,
        },
      ],
    });
  });

  it('reflects the activation after the asynchronous worker processes the order', async () => {
    const orderId = await createOrder();

    // TODO: instead of the stub, let the real consumer process the outbox event.
    simulateWorkerProcessing(context.store, orderId);

    const response = await request(context.app.getHttpServer())
      .get(`/orders/${orderId}/status`)
      .expect(200);

    expect(response.body).toMatchObject({
      orderId,
      status: OrderStatus.Active,
      processingStatus: ProcessingStatus.Completed,
    });
  });
});
