import {
  createRealServicesTestApp,
  RealServicesTestApp,
  waitUntil,
} from './support/real-services-test-app';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { OrderEntity, OutboxEventEntity } from '@app/orders/domain/entities';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/orders/domain/shared/types/order.type';
import {
  ORDER_RESERVATION_EXPIRED,
  orderEventSchema,
} from '@app/orders/messaging/order-events';
import { createEventMeta } from '@app/orders/messaging/event.util';
import { ProcessOrderEventUseCase } from '@app/orders/adapters/usecases/process-order-event.use-case';
import { ProductEntity } from '@app/products/domain/entities';
import {
  ReservationEntity,
  StockEntity,
} from '@app/products/inventory/domain/entities';
import { CATALOG_KEY } from '@app/products/adapters/usecases/get-products.use-case';
import { buildCheckoutPayload, newIdempotencyKey } from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';

describe('Scheduler reservation expiration (integration)', () => {
  let testContext: RealServicesTestApp | undefined;
  let product: ProductRecord;

  beforeEach(async () => {
    testContext = await createRealServicesTestApp();
    product = newProduct({ physicalQuantity: 10 });
    const { physicalQuantity, reservedQuantity, ...details } = product;

    await testContext.dataSource.getRepository(ProductEntity).insert(details);

    await testContext.dataSource.getRepository(StockEntity).insert({
      productId: product.id,
      physicalQuantity,
      reservedQuantity,
    });
  });

  afterEach(async () => {
    await testContext?.close();
    testContext = undefined;
  });

  async function checkout(testApp: RealServicesTestApp, expired: boolean) {
    const response = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .send(buildCheckoutPayload(product.id, 2))
      .expect(202);

    const orderId: string = response.body.orderId;

    expect(response.body.status).toBe(OrderStatus.Pending);

    await testApp.dataSource.query(
      `UPDATE stock_reservation
       SET expires_at = clock_timestamp() + $1 * interval '1 hour'
       WHERE order_id = $2`,
      [expired ? -1 : 1, orderId],
    );

    return orderId;
  }

  async function snapshot({ dataSource: database }: RealServicesTestApp) {
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
    const testApp = testContext!;
    const expiredId = await checkout(testApp, true);
    const validId = await checkout(testApp, false);
    const initialSnapshot = await snapshot(testApp);

    expect(initialSnapshot.orders).toHaveLength(2);

    expect(
      initialSnapshot.orders.every(
        (order) => order.status === OrderStatus.Pending,
      ),
    ).toBe(true);

    expect(initialSnapshot.reservations.map((entry) => entry.status)).toEqual([
      'ACTIVE',
      'ACTIVE',
    ]);

    expect(initialSnapshot.stock[0]).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 4,
    });

    const messages = await testApp.observe();

    expect((await testApp.offsets()).map(({ offset }) => offset)).toEqual([
      '0',
    ]);

    await expect(testApp.expireReservationsUseCase.execute()).resolves.toBe(1);

    expect(await snapshot(testApp)).toEqual(initialSnapshot);

    expect((await testApp.offsets()).map(({ offset }) => offset)).toEqual([
      '1',
    ]);

    await waitUntil(
      async () => messages.length === 1,
      'published expiration event',
    );

    const received = messages[0]!;

    expect(received.topic).toBe(testApp.checkoutTopic);
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
    const testApp = testContext!;
    const orderId = await checkout(testApp, true);
    const initialSnapshot = await snapshot(testApp);

    expect(initialSnapshot.orders[0]).toMatchObject({
      id: orderId,
      status: OrderStatus.Pending,
      processingStatus: ProcessingStatus.Pending,
    });

    expect(initialSnapshot.reservations[0]).toMatchObject({
      quantity: 2,
      status: 'ACTIVE',
    });

    expect(initialSnapshot.stock[0]).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 2,
    });

    expect(
      initialSnapshot.stock[0]!.physicalQuantity -
        initialSnapshot.stock[0]!.reservedQuantity,
    ).toBe(8);

    await request(testApp.app.getHttpServer()).get('/products').expect(200);

    expect(await testApp.redisConnection.redisClient.exists(CATALOG_KEY)).toBe(
      1,
    );

    const expiredReservationCount = async () => {
      const { values } =
        await testApp.metricsService.reservationTransitionsCounter.get();

      return (
        values.find(({ labels }) => labels.result === 'expired')?.value ?? 0
      );
    };

    const baseline = await expiredReservationCount();

    await testApp.startConsumer();

    await expect(testApp.expireReservationsUseCase.execute()).resolves.toBe(1);

    await waitUntil(
      async () => (await expiredReservationCount()) === baseline + 1,
      'consumer expiration completion',
    );

    const finalSnapshot = await snapshot(testApp);

    expect(finalSnapshot.orders[0]?.status).toBe(OrderStatus.Cancelled);
    expect(finalSnapshot.reservations[0]?.status).toBe('EXPIRED');

    expect(finalSnapshot.stock[0]).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 0,
    });

    expect(
      finalSnapshot.stock[0]!.physicalQuantity -
        finalSnapshot.stock[0]!.reservedQuantity,
    ).toBe(10);

    expect(await testApp.redisConnection.redisClient.exists(CATALOG_KEY)).toBe(
      0,
    );

    expect(await expiredReservationCount()).toBe(baseline + 1);

    expect(await testApp.metricsService.metricsRegistry.metrics()).toContain(
      `shop_reservations_total{result="expired"} ${baseline + 1}`,
    );
  });

  it('ignores a premature expiration event without cancelling the order or releasing its reservation', async () => {
    const testApp = testContext!;
    const orderId = await checkout(testApp, false);
    const initialSnapshot = await snapshot(testApp);

    await testApp.startConsumer();

    await testApp.orderMessaging.publish(testApp.checkoutTopic, orderId, {
      kind: ORDER_RESERVATION_EXPIRED,
      data: { order_id: orderId },
      meta: createEventMeta(randomUUID()),
    });

    await testApp.waitForConsumerOffset(1);

    expect(await snapshot(testApp)).toEqual(initialSnapshot);
  });

  it('handles a duplicate expiration event without releasing stock twice', async () => {
    const testApp = testContext!;
    const expiredId = await checkout(testApp, true);
    const validId = await checkout(testApp, false);
    const messages = await testApp.observe();

    await testApp.startConsumer();

    await testApp.expireReservationsUseCase.execute();

    await waitUntil(async () => {
      const order = await testApp.dataSource
        .getRepository(OrderEntity)
        .findOneBy({ id: expiredId });

      return order?.status === OrderStatus.Cancelled && messages.length === 1;
    }, 'initial expiration');

    const event = orderEventSchema.parse(
      JSON.parse(messages[0]!.message.value!.toString()),
    );

    await testApp.orderMessaging.publish(
      testApp.checkoutTopic,
      expiredId,
      event,
    );

    await testApp.waitForConsumerOffset(2);

    const finalSnapshot = await snapshot(testApp);

    expect(
      finalSnapshot.orders.find(({ id }) => id === expiredId)?.status,
    ).toBe(OrderStatus.Cancelled);

    expect(finalSnapshot.orders.find(({ id }) => id === validId)?.status).toBe(
      OrderStatus.Pending,
    );

    expect(finalSnapshot.stock[0]).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 2,
    });

    expect(
      finalSnapshot.reservations.find(({ orderId }) => orderId === expiredId)
        ?.status,
    ).toBe('EXPIRED');

    expect(
      finalSnapshot.reservations.find(({ orderId }) => orderId === validId)
        ?.status,
    ).toBe('ACTIVE');

    expect(await testApp.metricsService.metricsRegistry.metrics()).toContain(
      'shop_reservations_total{result="already_processed"} 1',
    );
  });

  it('keeps stock consistent when expiration races activation of an expired reservation', async () => {
    const testApp = testContext!;
    const orderId = await checkout(testApp, true);

    const outboxEvent = await testApp.dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId });

    const processOrderEventUseCase = testApp.app.get(ProcessOrderEventUseCase);

    await Promise.all([
      processOrderEventUseCase.handle(
        orderEventSchema.parse(outboxEvent.payload),
      ),
      processOrderEventUseCase.handle({
        kind: ORDER_RESERVATION_EXPIRED,
        data: { order_id: orderId },
        meta: createEventMeta(randomUUID()),
      }),
    ]);

    const finalSnapshot = await snapshot(testApp);

    expect(finalSnapshot.orders[0]?.status).toBe(OrderStatus.Cancelled);
    expect(finalSnapshot.reservations[0]?.status).toBe('EXPIRED');

    expect(finalSnapshot.stock[0]).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 0,
    });
  });
});
