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
  IdempotencyLogEntity,
  OrderEntity,
  OutboxEventEntity,
} from '@app/order/domain/entities';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { ActivationFailureHandler } from '@app/order/activation/handlers/activation-failure.handler';
import { StepName } from '@app/order/activation/constants/step-names';
import { ActivateOrderStep } from '@app/order/activation/steps/database-steps';
import { IntegrationSimulator } from '@app/order/activation/steps/integration-steps';
import {
  ORDER_CHECKOUT_INITIATED,
  orderEventSchema,
} from '@app/order/messaging/order-events';
import { createEventMeta } from '@app/order/messaging/event.util';
import { OutboxRepository } from '@app/order/repositories/outbox.repository';
import {
  ReservationEntity,
  StockEntity,
} from '@app/products/inventory/domain/entities';
import { buildCheckoutPayload, newIdempotencyKey } from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';

describe('Checkout messaging with PostgreSQL, Redis and Kafka (integration)', () => {
  let context: RealServicesTestApp | undefined;
  let product: ProductRecord;

  async function setup(
    simulator?: Parameters<typeof createRealServicesTestApp>[0],
  ): Promise<RealServicesTestApp> {
    context = await createRealServicesTestApp(simulator);
    product = await seedProduct(context.database, newProduct());

    return context;
  }

  async function checkout(testApp: RealServicesTestApp) {
    const key = newIdempotencyKey();
    const correlationId = randomUUID();
    const payload = buildCheckoutPayload(product.id);

    const response = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', key)
      .set('x-correlation-id', correlationId)
      .send(payload)
      .expect(202);

    return {
      orderId: response.body.orderId as string,
      key,
      correlationId,
      payload,
    };
  }

  async function waitForOrder(
    testApp: RealServicesTestApp,
    orderId: string,
    processingStatus: ProcessingStatus,
    attempt: number,
  ) {
    const orders = testApp.database.getRepository(OrderEntity);

    await waitUntil(async () => {
      const order = await orders.findOneBy({ id: orderId });

      return (
        order?.processingStatus === processingStatus &&
        order.lastAttempt === attempt
      );
    }, `order ${orderId} at ${processingStatus}, attempt ${attempt}`);

    return orders.findOneByOrFail({ id: orderId });
  }

  async function makeAvailable(testApp: RealServicesTestApp, eventId: string) {
    await testApp.database.query(
      `UPDATE outbox_events SET available_at = clock_timestamp() WHERE id = $1`,
      [eventId],
    );
  }

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  it('processes the outbox through Kafka once, propagates traces and ignores duplicate delivery', async () => {
    const logs = jest.spyOn(PinoLogger.prototype, 'info');
    const testApp = await setup();
    const received = await testApp.observe();

    await testApp.startConsumer();
    const purchase = await checkout(testApp);

    const outbox = await testApp.database
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId: purchase.orderId });

    const event = orderEventSchema.parse(outbox.payload);

    expect(event).toMatchObject({
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: purchase.orderId },
      meta: { correlation_id: purchase.correlationId, attempt: 1 },
    });

    await testApp.relay.execute();

    await waitForOrder(
      testApp,
      purchase.orderId,
      ProcessingStatus.Completed,
      1,
    );

    await waitUntil(async () => received.length === 1, 'checkout Kafka record');
    await testApp.waitForConsumerOffset(1);

    expect(received[0]!.message.key?.toString()).toBe(purchase.orderId);

    expect(
      orderEventSchema.parse(
        JSON.parse(received[0]!.message.value!.toString()),
      ),
    ).toEqual(event);

    const status = await request(testApp.app.getHttpServer())
      .get(`/orders/${purchase.orderId}/status`)
      .expect(200);

    expect(status.body).toMatchObject({
      orderId: purchase.orderId,
      status: OrderStatus.Active,
      processingStatus: ProcessingStatus.Completed,
      items: [{ productId: product.id, quantity: 1, netPrice: 2990 }],
    });

    expect(
      await testApp.database
        .getRepository(OutboxEventEntity)
        .findOneByOrFail({ id: outbox.id }),
    ).toMatchObject({ status: 'PROCESSED', leaseToken: null });

    expect(
      await testApp.database
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });

    expect(
      await testApp.database
        .getRepository(ReservationEntity)
        .findOneByOrFail({ orderId: purchase.orderId }),
    ).toMatchObject({ status: 'CONSUMED', quantity: 1 });

    const journal = testApp.database.getRepository(IdempotencyLogEntity);

    expect(
      (await journal.findBy({ orderId: purchase.orderId, success: true }))
        .map(({ step }) => step)
        .sort(),
    ).toEqual(Object.values(StepName).sort());

    const receivedLog = logs.mock.calls.find(
      ([, message]) => message === 'order.event.received',
    );

    expect(receivedLog?.[0]).toMatchObject({
      correlation_id: purchase.correlationId,
      order_id: purchase.orderId,
      trace_id: event.meta!.trace_id,
      event_id: event.meta!.event_id,
    });

    for (const name of [
      'checkout.transaction',
      'outbox.publish',
      'order.activation',
    ]) {

      expect(
        logs.mock.calls.some(
          ([fields, message]) =>
            message === 'trace.span' &&
            typeof fields === 'object' &&
            fields !== null &&
            'name' in fields &&
            fields.name === name &&
            'correlation_id' in fields &&
            fields.correlation_id === purchase.correlationId,
        ),
      ).toBe(true);

    }

    await testApp.messaging.publish(
      testApp.topic,
      purchase.orderId,
      outbox.payload,
    );

    await testApp.messaging.publish(
      testApp.topic,
      purchase.orderId,
      outbox.payload,
    );

    await testApp.waitForConsumerOffset(3);

    const replay = await request(testApp.app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', purchase.key)
      .send(purchase.payload)
      .expect(202);

    expect(replay.body).toEqual({
      orderId: purchase.orderId,
      status: OrderStatus.Pending,
    });

    expect(await journal.countBy({ orderId: purchase.orderId })).toBe(4);

    expect(
      await testApp.database
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });

    const metrics = await request(testApp.app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(metrics.text).toContain(
      'shop_processing_total{result="completed"} 1',
    );

    expect(metrics.text).toContain(
      'shop_processing_total{result="published"} 1',
    );

    expect(metrics.text).toContain('shop_checkout_total{result="replayed"} 1');
  });

  it('resumes a transient email failure without repeating successful ERP or stock steps', async () => {
    const testApp = await setup({ EMAIL_FAILURES: 1 });

    const simulator = jest.spyOn(
      testApp.app.get(IntegrationSimulator),
      'execute',
    );

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    await testApp.relay.execute();

    const retrying = await waitForOrder(
      testApp,
      orderId,
      ProcessingStatus.Retrying,
      1,
    );

    expect(retrying.status).toBe(OrderStatus.Active);

    const retry = await testApp.database
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId, status: 'PENDING' });

    expect(orderEventSchema.parse(retry.payload)).toMatchObject({
      kind: ORDER_CHECKOUT_INITIATED,
      meta: { attempt: 2 },
    });

    expect(
      retry.availableAt.getTime() - retry.createdAt.getTime(),
    ).toBeGreaterThanOrEqual(980);

    await waitUntil(async () => {
      const [row] = await testApp.database.query(
        `SELECT available_at <= clock_timestamp() AS ready FROM outbox_events WHERE id = $1`,
        [retry.id],
      );

      return row.ready === true;
    }, 'first retry backoff');

    await testApp.relay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 2);

    const records = await testApp.database
      .getRepository(IdempotencyLogEntity)
      .findBy({ orderId });

    expect(records.filter(({ success }) => success)).toHaveLength(4);

    expect(records.filter(({ success }) => !success)).toMatchObject([
      { step: StepName.EmailNotificationStep },
    ]);

    expect(
      simulator.mock.calls.filter(([kind]) => kind === 'erp'),
    ).toHaveLength(1);

    expect(
      simulator.mock.calls.filter(([kind]) => kind === 'email'),
    ).toHaveLength(2);

    expect(
      await testApp.database
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('rolls back stock consumption if activation fails, then completes on retry', async () => {
    const testApp = await setup();

    jest
      .spyOn(testApp.app.get(ActivateOrderStep), 'exec')
      .mockRejectedValueOnce(new Error('simulated activation failure'));

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    await testApp.relay.execute();

    const order = await waitForOrder(
      testApp,
      orderId,
      ProcessingStatus.Retrying,
      1,
    );

    expect(order.status).toBe(OrderStatus.Pending);

    expect(
      await testApp.database
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 10, reservedQuantity: 1 });

    expect(
      await testApp.database
        .getRepository(ReservationEntity)
        .findOneByOrFail({ orderId }),
    ).toMatchObject({ status: 'ACTIVE' });

    expect(
      await testApp.database
        .getRepository(IdempotencyLogEntity)
        .countBy({ orderId, success: true }),
    ).toBe(0);

    const retry = await testApp.database
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId, status: 'PENDING' });

    await makeAvailable(testApp, retry.id);
    await testApp.relay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 2);

    expect(
      await testApp.database
        .getRepository(IdempotencyLogEntity)
        .countBy({ orderId, success: true }),
    ).toBe(4);

    expect(
      await testApp.database
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('exhausts five ERP attempts with exponential backoff and publishes a terminal DLQ event', async () => {
    const testApp = await setup({ ERP_FAILURES: 5, SIMULATOR_DELAY_MS: 0 });
    const deadLetters = await testApp.observe(`${testApp.topic}.dlq`);

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    for (let attempt = 1; attempt <= 5; attempt += 1) {

      await testApp.relay.execute();
      const terminal = attempt === 5;

      const order = await waitForOrder(
        testApp,
        orderId,
        terminal ? ProcessingStatus.Failed : ProcessingStatus.Retrying,
        attempt,
      );

      expect(order.status).toBe(OrderStatus.Active);

      const next = await testApp.database
        .getRepository(OutboxEventEntity)
        .findOneByOrFail({ orderId, status: 'PENDING' });

      expect(next.topic).toBe(
        terminal ? `${testApp.topic}.dlq` : testApp.topic,
      );

      if (!terminal) {

        const delayMs = next.availableAt.getTime() - next.createdAt.getTime();
        const expectedMs = 2 ** (attempt - 1) * 1000;

        expect(delayMs).toBeGreaterThanOrEqual(expectedMs - 20);
        expect(delayMs).toBeLessThan(expectedMs + 2000);

        expect(orderEventSchema.parse(next.payload)).toMatchObject({
          meta: { attempt: attempt + 1 },
        });

        await makeAvailable(testApp, next.id);

      }

    }

    await testApp.relay.execute();

    await waitUntil(
      async () => deadLetters.length === 1,
      'terminal DLQ record',
    );

    expect(deadLetters[0]!.message.key?.toString()).toBe(orderId);

    expect(
      orderEventSchema.parse(
        JSON.parse(deadLetters[0]!.message.value!.toString()),
      ),
    ).toMatchObject({
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: orderId },
      meta: { attempt: 5 },
    });

    const records = await testApp.database
      .getRepository(IdempotencyLogEntity)
      .findBy({ orderId });

    expect(records.filter(({ success }) => success)).toHaveLength(2);
    expect(records.filter(({ success }) => !success)).toHaveLength(5);

    expect(
      records
        .filter(({ success }) => !success)
        .every(({ step }) => step === StepName.UpdateErpStep),
    ).toBe(true);

    expect(
      await testApp.database
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('dead-letters a permanent integration failure immediately without restoring consumed stock', async () => {
    const testApp = await setup({
      SIMULATOR_PERMANENT_FAILURE: 'erp',
      SIMULATOR_DELAY_MS: 0,
    });

    const deadLetters = await testApp.observe(`${testApp.topic}.dlq`);

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    await testApp.relay.execute();

    const order = await waitForOrder(
      testApp,
      orderId,
      ProcessingStatus.Failed,
      1,
    );

    expect(order.status).toBe(OrderStatus.Active);
    await testApp.relay.execute();

    await waitUntil(
      async () => deadLetters.length === 1,
      'permanent error DLQ',
    );

    expect(deadLetters[0]!.message.key?.toString()).toBe(orderId);

    expect(
      await testApp.database
        .getRepository(IdempotencyLogEntity)
        .findBy({ orderId, success: false }),
    ).toMatchObject([{ step: StepName.UpdateErpStep }]);

    expect(
      await testApp.database
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('keeps an unpublished outbox event pending and recovers after the publisher fails', async () => {
    const testApp = await setup();
    const connect = jest.spyOn(testApp.messaging, 'ensureConnected');

    const publish = jest
      .spyOn(testApp.messaging, 'publish')
      .mockRejectedValueOnce(new Error('simulated broker outage'));

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    expect(connect).not.toHaveBeenCalled();
    await testApp.relay.execute();

    const pending = await testApp.database
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId });

    expect(pending).toMatchObject({ status: 'PENDING', leaseToken: null });
    expect((await testApp.offsets())[0]?.offset).toBe('0');
    await makeAvailable(testApp, pending.id);
    await testApp.relay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 1);

    expect(publish).toHaveBeenCalledTimes(2);

    expect(
      await testApp.database
        .getRepository(OutboxEventEntity)
        .findOneByOrFail({ id: pending.id }),
    ).toMatchObject({ status: 'PROCESSED', leaseToken: null });

    expect((await testApp.offsets())[0]?.offset).toBe('1');
  });

  it('reclaims an expired outbox lease and safely consumes a duplicate publication', async () => {
    const testApp = await setup();
    const { orderId } = await checkout(testApp);
    const repository = testApp.app.get(OutboxRepository);
    const claimed = await repository.claim();

    expect(claimed).toHaveLength(1);

    await testApp.messaging.publish(
      testApp.topic,
      orderId,
      claimed[0]!.payload,
    );

    await testApp.database.query(
      `UPDATE outbox_events SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [claimed[0]!.id],
    );

    await testApp.relay.execute();
    expect((await testApp.offsets())[0]?.offset).toBe('2');
    await testApp.startConsumer();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 1);
    await testApp.waitForConsumerOffset(2);

    expect(
      await testApp.database
        .getRepository(IdempotencyLogEntity)
        .countBy({ orderId, success: true }),
    ).toBe(4);

    expect(
      await testApp.database
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('redelivers a message when persisting a failed activation temporarily fails', async () => {
    const testApp = await setup({ ERP_FAILURES: 1, SIMULATOR_DELAY_MS: 0 });
    const errors = jest.spyOn(PinoLogger.prototype, 'error');
    const failureHandler = testApp.app.get(ActivationFailureHandler);

    const failure = jest
      .spyOn(failureHandler, 'handle')
      .mockRejectedValueOnce(new Error('simulated database outage'));

    const deadLetters = await testApp.observe(`${testApp.topic}.dlq`);

    await testApp.startConsumer();
    const { orderId, correlationId } = await checkout(testApp);

    await testApp.relay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Retrying, 1);

    expect(failure).toHaveBeenCalledTimes(2);
    expect(deadLetters).toHaveLength(0);

    const failureLog = errors.mock.calls.find(
      ([, message]) => message === 'order.event.dispatch.failed',
    );

    expect(failureLog?.[0]).toMatchObject({
      correlation_id: correlationId,
      order_id: orderId,
      trace_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      context: [{ error_type: 'Error' }],
    });

    const retry = await testApp.database
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId, status: 'PENDING' });

    await makeAvailable(testApp, retry.id);
    await testApp.relay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 2);
    expect(deadLetters).toHaveLength(0);
  });

  it('dead-letters an invalid event safely and retries a failed DLQ publication', async () => {
    const testApp = await setup();
    const deadLetters = await testApp.observe(`${testApp.topic}.dlq`);

    await testApp.startConsumer();
    const originalPublish = testApp.messaging.publish.bind(testApp.messaging);
    let dlqAttempts = 0;

    const publish = jest
      .spyOn(testApp.messaging, 'publish')
      .mockImplementation(async (topic, key, payload, headers) => {
        if (topic === `${testApp.topic}.dlq` && ++dlqAttempts === 1) {

          throw new Error('simulated DLQ outage');

        }

        return originalPublish(topic, key, payload, headers);
      });

    await testApp.messaging.publish(testApp.topic, 'invalid', {
      secret: 'private-test-value',
      kind: 'UNKNOWN',
    });

    await waitUntil(async () => deadLetters.length === 1, 'invalid event DLQ');
    await testApp.waitForConsumerOffset(1);

    const message = deadLetters[0]!.message;
    const body = message.value!.toString();

    expect(dlqAttempts).toBe(2);
    expect(publish).toHaveBeenCalledTimes(3);

    expect(message.headers?.['x-dlq-reason']?.toString()).toBe(
      'Invalid event payload',
    );

    expect(message.headers?.['x-source-topic']?.toString()).toBe(testApp.topic);
    expect(message.headers?.['x-source-partition']?.toString()).toBe('0');
    expect(message.headers?.['x-source-offset']?.toString()).toBe('0');

    expect(JSON.parse(body)).toEqual({
      source: { topic: testApp.topic, partition: 0, offset: '0' },
      reason: 'Invalid event payload',
    });

    expect(body).not.toContain('private-test-value');
    expect(body).not.toContain('secret');
  });

  it('dead-letters a valid event that refers to an unknown order as a permanent error', async () => {
    const testApp = await setup();
    const deadLetters = await testApp.observe(`${testApp.topic}.dlq`);

    await testApp.startConsumer();
    const orderId = randomUUID();

    const event = {
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: orderId },
      meta: { ...createEventMeta(randomUUID()), attempt: 1 },
    };

    await testApp.messaging.publish(testApp.topic, orderId, event);
    await waitUntil(async () => deadLetters.length === 1, 'unknown-order DLQ');
    await testApp.waitForConsumerOffset(1);

    expect(deadLetters[0]!.message.key?.toString()).toBe(orderId);

    expect(deadLetters[0]!.message.headers?.['x-dlq-reason']?.toString()).toBe(
      'Unknown order',
    );

    expect(JSON.parse(deadLetters[0]!.message.value!.toString())).toEqual(
      event,
    );

    expect(
      await testApp.database.getRepository(OutboxEventEntity).count(),
    ).toBe(0);
  });
});
