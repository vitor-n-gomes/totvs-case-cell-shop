import {
  createRealServicesTestApp,
  RealServicesTestApp,
  seedProduct,
  waitUntil,
} from './support/real-services-test-app';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import {
  OrderEntity,
  OrderItemEntity,
  OutboxEventEntity,
} from '@app/orders/domain/entities';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/orders/domain/shared/types/order.type';
import {
  ORDER_CHECKOUT_INITIATED,
  orderEventSchema,
} from '@app/orders/messaging/order-events';
import { OutboxRepository } from '@app/orders/repositories/outbox.repository';
import { RequestLogEntity } from '@app/platform/database/request-log.entity';
import {
  ReservationEntity,
  StockEntity,
} from '@app/products/inventory/domain/entities';
import { buildCheckoutPayload, newIdempotencyKey } from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';

describe('Checkout with PostgreSQL, Redis and Kafka (integration)', () => {
  let testContext: RealServicesTestApp | undefined;
  let product: ProductRecord;

  beforeEach(async () => {
    testContext = await createRealServicesTestApp();

    product = await seedProduct(
      testContext.dataSource,
      newProduct({ physicalQuantity: 5 }),
    );
  });

  afterEach(async () => {
    await testContext?.close();
    testContext = undefined;
  });

  it('prevents overselling when 20 independent checkouts compete for five units', async () => {
    const testApp = testContext!;

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(testApp.app.getHttpServer())
          .post('/checkout')
          .set('Idempotency-Key', newIdempotencyKey())
          .send(buildCheckoutPayload(product.id)),
      ),
    );

    expect(responses.filter(({ status }) => status === 202)).toHaveLength(5);
    expect(responses.filter(({ status }) => status === 409)).toHaveLength(15);

    const stock = await testApp.dataSource
      .getRepository(StockEntity)
      .findOneByOrFail({ productId: product.id });

    expect(stock).toMatchObject({ physicalQuantity: 5, reservedQuantity: 5 });
    expect(await testApp.dataSource.getRepository(OrderEntity).count()).toBe(5);

    expect(
      await testApp.dataSource.getRepository(OrderItemEntity).count(),
    ).toBe(5);

    const reservations = await testApp.dataSource
      .getRepository(ReservationEntity)
      .find();

    expect(reservations).toHaveLength(5);
    expect(reservations.every((entry) => entry.status === 'ACTIVE')).toBe(true);

    expect(
      reservations.reduce((total, entry) => total + entry.quantity, 0),
    ).toBe(5);

    expect(
      await testApp.dataSource.getRepository(OutboxEventEntity).count(),
    ).toBe(5);
  });

  it('serializes simultaneous idempotent retries and rejects changed content', async () => {
    const testApp = testContext!;
    const key = newIdempotencyKey();
    const correlationId = randomUUID();
    const payload = buildCheckoutPayload(product.id, 2);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(testApp.app.getHttpServer())
          .post('/checkout')
          .set('Idempotency-Key', key)
          .set('x-correlation-id', correlationId)
          .send(payload),
      ),
    );

    expect(responses.every(({ status }) => status === 202)).toBe(true);
    const accepted = responses[0]!.body;

    expect(accepted).toMatchObject({
      orderId: expect.any(String),
      status: OrderStatus.Pending,
    });

    expect(
      responses.every(({ body }) => body.orderId === accepted.orderId),
    ).toBe(true);

    await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .send(buildCheckoutPayload(product.id, 3))
      .expect(409);

    expect(await testApp.dataSource.getRepository(OrderEntity).count()).toBe(1);

    expect(
      await testApp.dataSource.getRepository(ReservationEntity).count(),
    ).toBe(1);

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 5, reservedQuantity: 2 });

    const outbox = await testApp.dataSource
      .getRepository(OutboxEventEntity)
      .find();

    expect(outbox).toHaveLength(1);

    expect(outbox[0]).toMatchObject({
      orderId: accepted.orderId,
      topic: testApp.checkoutTopic,
      status: 'PENDING',
    });

    expect(orderEventSchema.parse(outbox[0]!.payload)).toMatchObject({
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: accepted.orderId },
      meta: { correlation_id: correlationId, attempt: 1 },
    });

    const status = await request(testApp.app.getHttpServer())
      .get(`/orders/${accepted.orderId as string}/status`)
      .expect(200);

    expect(status.body).toMatchObject({
      orderId: accepted.orderId,
      status: OrderStatus.Pending,
      processingStatus: ProcessingStatus.Pending,
      items: [
        {
          productId: product.id,
          quantity: 2,
          netPrice: product.netPrice,
          listPrice: product.listPrice,
        },
      ],
    });

    expect(status.body).not.toHaveProperty('mainContact');
    expect(status.body).not.toHaveProperty('altContact');
  });

  it('rolls back the complete cart when a later item is missing or out of stock', async () => {
    const testApp = testContext!;

    const available = await seedProduct(
      testApp.dataSource,
      newProduct({
        id: '00000000-0000-4000-8000-000000000001',
        productKey: 'available',
      }),
    );

    const unavailable = await seedProduct(
      testApp.dataSource,
      newProduct({
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        productKey: 'unavailable',
        physicalQuantity: 0,
      }),
    );

    const missingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    for (const [otherId, expectedStatus] of [
      [missingId, 404],
      [unavailable.id, 409],
    ] as const) {

      const payload = {
        ...buildCheckoutPayload(available.id),
        items: [
          { productId: otherId, quantity: 1 },
          { productId: available.id, quantity: 1 },
        ],
      };

      await request(testApp.app.getHttpServer())
        .post('/checkout')
        .set('Idempotency-Key', newIdempotencyKey())
        .send(payload)
        .expect(expectedStatus);

      expect(
        await testApp.dataSource
          .getRepository(StockEntity)
          .findOneByOrFail({ productId: available.id }),
      ).toMatchObject({ physicalQuantity: 10, reservedQuantity: 0 });

      expect(await testApp.dataSource.getRepository(OrderEntity).count()).toBe(
        0,
      );

      expect(
        await testApp.dataSource.getRepository(OrderItemEntity).count(),
      ).toBe(0);

      expect(
        await testApp.dataSource.getRepository(ReservationEntity).count(),
      ).toBe(0);

      expect(
        await testApp.dataSource.getRepository(OutboxEventEntity).count(),
      ).toBe(0);

    }
  });

  it('treats the same cart in a different item order as an idempotent replay', async () => {
    const testApp = testContext!;

    const other = await seedProduct(
      testApp.dataSource,
      newProduct({ productKey: 'other-case' }),
    );

    const key = newIdempotencyKey();

    const payload = {
      ...buildCheckoutPayload(product.id),
      items: [
        { productId: product.id, quantity: 1 },
        { productId: other.id, quantity: 2 },
      ],
    };

    const first = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(202);

    const replay = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .send({ ...payload, items: [...payload.items].reverse() })
      .expect(202);

    expect(replay.body).toEqual(first.body);
    expect(await testApp.dataSource.getRepository(OrderEntity).count()).toBe(1);

    expect(
      await testApp.dataSource.getRepository(ReservationEntity).count(),
    ).toBe(2);

    expect(
      await testApp.dataSource.getRepository(OutboxEventEntity).count(),
    ).toBe(1);
  });

  it('rolls back the order and stock if writing its outbox event fails', async () => {
    const testApp = testContext!;
    const key = newIdempotencyKey();
    const payload = buildCheckoutPayload(product.id, 2);

    jest
      .spyOn(testApp.app.get(OutboxRepository), 'append')
      .mockRejectedValueOnce(new Error('simulated outbox write failure'));

    const failed = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(500);

    expect(JSON.stringify(failed.body)).not.toContain('simulated outbox');
    expect(await testApp.dataSource.getRepository(OrderEntity).count()).toBe(0);

    expect(
      await testApp.dataSource.getRepository(OrderItemEntity).count(),
    ).toBe(0);

    expect(
      await testApp.dataSource.getRepository(ReservationEntity).count(),
    ).toBe(0);

    expect(
      await testApp.dataSource.getRepository(OutboxEventEntity).count(),
    ).toBe(0);

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 5, reservedQuantity: 0 });

    await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(202);

    expect(await testApp.dataSource.getRepository(OrderEntity).count()).toBe(1);

    expect(
      await testApp.dataSource.getRepository(OutboxEventEntity).count(),
    ).toBe(1);
  });

  it('exposes the HTTP contract, redacted audit records and metrics', async () => {
    const testApp = testContext!;
    const logs = jest.spyOn(PinoLogger.prototype, 'info');
    const correlationId = randomUUID();

    const payload = {
      ...buildCheckoutPayload(product.id),
      altContact: 'alternate@example.test',
    };

    const invalid = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('x-correlation-id', correlationId)
      .send(payload)
      .expect(400);

    expect(invalid.body).toMatchObject({
      statusCode: 400,
      error: expect.any(String),
      message: expect.any(String),
      correlationId,
    });

    expect(invalid.headers['x-correlation-id']).toBe(correlationId);

    await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .send({
        ...payload,
        items: [payload.items[0], payload.items[0]],
      })
      .expect(400);

    await request(testApp.app.getHttpServer())
      .get(`/orders/${randomUUID()}/status`)
      .expect(404);

    await request(testApp.app.getHttpServer())
      .get('/orders/not-a-uuid/status')
      .expect(400);

    const acceptedCorrelation = randomUUID();

    const accepted = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', newIdempotencyKey())
      .set('x-correlation-id', acceptedCorrelation)
      .send(payload)
      .expect(202);

    expect(accepted.headers['x-correlation-id']).toBe(acceptedCorrelation);

    await waitUntil(
      async () =>
        (await testApp.dataSource
          .getRepository(RequestLogEntity)
          .countBy({ correlationId: acceptedCorrelation })) === 1,
      'redacted request audit',
    );

    const audit = await testApp.dataSource
      .getRepository(RequestLogEntity)
      .findOneByOrFail({ correlationId: acceptedCorrelation });

    expect(audit).toMatchObject({
      method: 'POST',
      url: '/checkout',
      payload: {
        mainContact: '[redacted]',
        altContact: '[redacted]',
        items: payload.items,
      },
    });

    expect(JSON.stringify(audit.payload)).not.toContain('example.test');
    expect(JSON.stringify(logs.mock.calls)).not.toContain(payload.mainContact);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(payload.altContact);

    const metricsService = await request(testApp.app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(metricsService.text).toContain(
      'shop_checkout_total{result="accepted"} 1',
    );

    expect(metricsService.text).toContain(
      'shop_request_log_total{result="saved"}',
    );

    const openapi = await request(testApp.app.getHttpServer())
      .get('/api-docs-json')
      .expect(200);

    const checkout = openapi.body.paths['/checkout'].post;

    expect(
      checkout.responses['202'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/CheckoutAcceptedDto' });

    for (const status of ['400', '404', '409', '503']) {

      expect(
        checkout.responses[status].content['application/json'].schema,
      ).toEqual({ $ref: '#/components/schemas/ErrorResponseDto' });

    }

    expect(openapi.body.paths['/products'].get.responses['200']).toBeDefined();

    expect(
      openapi.body.paths['/orders/{orderId}/status'].get.responses['200'],
    ).toBeDefined();
  });
});
