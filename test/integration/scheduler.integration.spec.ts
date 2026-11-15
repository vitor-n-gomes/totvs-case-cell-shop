import {
  createSchedulerTestApp,
  SchedulerTestApp,
  waitUntil,
} from './support/scheduler-test-app';
import request from 'supertest';
import { OrderEntity } from '@app/order/domain/entities';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import {
  ORDER_RESERVATION_EXPIRED,
  orderEventSchema,
} from '@app/order/messaging/order-events';
import { ProductEntity } from '@app/products/domain/entities';
import {
  ReservationEntity,
  StockEntity,
} from '@app/products/inventory/domain/entities';
import { CATALOG_KEY } from '@app/products/adapters/usecases/get-products.use-case';
import { buildCheckoutPayload, newIdempotencyKey } from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';

describe('Scheduler reservation expiration (integration)', () => {
  let context: SchedulerTestApp | undefined;
  let product: ProductRecord;

  beforeEach(async () => {
    context = await createSchedulerTestApp();
    product = newProduct({ physicalQuantity: 10 });
    const { physicalQuantity, reservedQuantity, ...details } = product;
    await context.database.getRepository(ProductEntity).insert(details);
    await context.database.getRepository(StockEntity).insert({
      productId: product.id,
      physicalQuantity,
      reservedQuantity,
    });
  });

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function checkout(testApp: SchedulerTestApp, expired: boolean) {
    const response = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .send(buildCheckoutPayload(product.id, 2))
      .expect(202);
    const orderId: string = response.body.orderId;
    expect(response.body.status).toBe(OrderStatus.Pending);
    await testApp.database.query(
      `UPDATE stock_reservation
       SET expires_at = clock_timestamp() + $1 * interval '1 hour'
       WHERE order_id = $2`,
      [expired ? -1 : 1, orderId],
    );
    return orderId;
  }

  async function snapshot({ database }: SchedulerTestApp) {
    return {
      orders: await database
        .getRepository(OrderEntity)
        .find({ order: { id: 'ASC' } }),
      reservations: await database
        .getRepository(ReservationEntity)
        .find({ order: { id: 'ASC' } }),
      stock: await database.getRepository(StockEntity).find(),
    };
  }

  it('publishes only the expired reservation keyed by order id without changing orders or stock', async () => {
    const testApp = context!;
    const expiredId = await checkout(testApp, true);
    const validId = await checkout(testApp, false);
    const before = await snapshot(testApp);
    expect(before.orders).toHaveLength(2);
    expect(
      before.orders.every((order) => order.status === OrderStatus.Pending),
    ).toBe(true);
    expect(before.reservations.map((entry) => entry.status)).toEqual([
      'ACTIVE',
      'ACTIVE',
    ]);
    expect(before.stock[0]).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 4,
    });
    const messages = await testApp.observe();
    expect((await testApp.offsets()).map(({ offset }) => offset)).toEqual([
      '0',
    ]);

    await expect(testApp.scheduler.execute()).resolves.toBe(1);

    expect(await snapshot(testApp)).toEqual(before);
    expect((await testApp.offsets()).map(({ offset }) => offset)).toEqual([
      '1',
    ]);
    await waitUntil(
      async () => messages.length === 1,
      'published expiration event',
    );
    const received = messages[0]!;
    expect(received.topic).toBe(testApp.topic);
    expect(received.message.key?.toString()).toBe(expiredId);
    const payload: unknown = JSON.parse(received.message.value!.toString());
    const event = orderEventSchema.parse(payload);
    expect(event).toEqual({
      kind: ORDER_RESERVATION_EXPIRED,
      data: { order_id: expiredId },
      meta: {
        schema_version: 1,
        event_id: expect.any(String),
        occurred_at: expect.any(String),
        correlation_id: expect.any(String),
        trace_id: expect.any(String),
        parent_span_id: expect.any(String),
      },
    });
    expect(event.data.order_id).not.toBe(validId);
  });

  it('cancels the expired order through Kafka, releases stock, invalidates the catalog and records the expiration', async () => {
    const testApp = context!;
    const orderId = await checkout(testApp, true);
    const before = await snapshot(testApp);
    expect(before.orders[0]).toMatchObject({
      id: orderId,
      status: OrderStatus.Pending,
      processingStatus: ProcessingStatus.Pending,
    });
    expect(before.reservations[0]).toMatchObject({
      quantity: 2,
      status: 'ACTIVE',
    });
    expect(before.stock[0]).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 2,
    });
    expect(
      before.stock[0]!.physicalQuantity - before.stock[0]!.reservedQuantity,
    ).toBe(8);
    await request(testApp.app.getHttpServer()).get('/products').expect(200);
    expect(await testApp.redis.client.exists(CATALOG_KEY)).toBe(1);
    const expiredCount = async () => {
      const { values } = await testApp.metrics.reservations.get();
      return (
        values.find(({ labels }) => labels.result === 'expired')?.value ?? 0
      );
    };
    const baseline = await expiredCount();
    await testApp.startConsumer();

    await expect(testApp.scheduler.execute()).resolves.toBe(1);

    await waitUntil(
      async () => (await expiredCount()) === baseline + 1,
      'consumer expiration completion',
    );
    const after = await snapshot(testApp);
    expect(after.orders[0]?.status).toBe(OrderStatus.Cancelled);
    expect(after.reservations[0]?.status).toBe('EXPIRED');
    expect(after.stock[0]).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 0,
    });
    expect(
      after.stock[0]!.physicalQuantity - after.stock[0]!.reservedQuantity,
    ).toBe(10);
    expect(await testApp.redis.client.exists(CATALOG_KEY)).toBe(0);
    expect(await expiredCount()).toBe(baseline + 1);
    expect(await testApp.metrics.registry.metrics()).toContain(
      `shop_reservations_total{result="expired"} ${baseline + 1}`,
    );
  });
});
