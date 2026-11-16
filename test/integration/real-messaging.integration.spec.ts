import {
  createRealServicesTestApp,
  RealServicesTestApp,
  seedProduct,
  waitUntil,
} from './support/real-services-test-app';
import { randomUUID } from 'node:crypto';
import { KafkaJSError } from 'kafkajs';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import {
  IdempotencyLogEntity,
  OrderEntity,
  OutboxEventEntity,
} from '@app/orders/domain/entities';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/orders/domain/shared/types/order.type';
import { ActivationFailureHandler } from '@app/orders/activation/handlers/activation-failure.handler';
import { StepName } from '@app/orders/activation/constants/step-names';
import { ActivateOrderStep } from '@app/orders/activation/steps/database-steps';
import { IntegrationSimulator } from '@app/orders/activation/steps/integration-steps';
import {
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  orderEventSchema,
} from '@app/orders/messaging/order-events';
import { createEventMeta } from '@app/orders/messaging/event.util';
import { CheckoutInitiatedHandler } from '@app/orders/adapters/usecases/event-handlers/checkout-initiated.handler';
import { ReservationExpiredHandler } from '@app/orders/adapters/usecases/event-handlers/reservation-expired.handler';
import { OutboxRepository } from '@app/orders/repositories/outbox.repository';
import {
  ReservationEntity,
  StockEntity,
} from '@app/products/inventory/domain/entities';
import { buildCheckoutPayload, newIdempotencyKey } from './support/fixtures';
import { newProduct, ProductRecord } from './support/in-memory-store';

describe('Checkout messaging with PostgreSQL, Redis and Kafka (integration)', () => {
  let testContext: RealServicesTestApp | undefined;
  let product: ProductRecord;

  async function setup(
    simulatorSettings?: Parameters<typeof createRealServicesTestApp>[0],
  ): Promise<RealServicesTestApp> {
    testContext = await createRealServicesTestApp(simulatorSettings);
    product = await seedProduct(testContext.dataSource, newProduct());

    return testContext;
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
    const orderTypeOrmRepository =
      testApp.dataSource.getRepository(OrderEntity);

    await waitUntil(async () => {
      const order = await orderTypeOrmRepository.findOneBy({ id: orderId });

      return (
        order?.processingStatus === processingStatus &&
        order.lastAttempt === attempt
      );
    }, `order ${orderId} at ${processingStatus}, attempt ${attempt}`);

    return orderTypeOrmRepository.findOneByOrFail({ id: orderId });
  }

  async function makeAvailable(testApp: RealServicesTestApp, eventId: string) {
    await testApp.dataSource.query(
      `UPDATE outbox_events SET available_at = clock_timestamp() WHERE id = $1`,
      [eventId],
    );
  }

  afterEach(async () => {
    await testContext?.close();
    testContext = undefined;
  });

  it('processes the outbox through Kafka once, propagates traces and ignores duplicate delivery', async () => {
    const logs = jest.spyOn(PinoLogger.prototype, 'info');
    const testApp = await setup();
    const receivedMessages = await testApp.observe();

    await testApp.startConsumer();
    const purchase = await checkout(testApp);

    const outboxEvent = await testApp.dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId: purchase.orderId });

    const event = orderEventSchema.parse(outboxEvent.payload);

    expect(event).toMatchObject({
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: purchase.orderId },
      meta: { correlation_id: purchase.correlationId, attempt: 1 },
    });

    await testApp.outboxRelay.execute();

    await waitForOrder(
      testApp,
      purchase.orderId,
      ProcessingStatus.Completed,
      1,
    );

    await waitUntil(
      async () => receivedMessages.length === 1,
      'checkout Kafka record',
    );

    await testApp.waitForConsumerOffset(1);

    expect(receivedMessages[0]!.message.key?.toString()).toBe(purchase.orderId);

    expect(
      orderEventSchema.parse(
        JSON.parse(receivedMessages[0]!.message.value!.toString()),
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
      await testApp.dataSource
        .getRepository(OutboxEventEntity)
        .findOneByOrFail({ id: outboxEvent.id }),
    ).toMatchObject({ status: 'PROCESSED', leaseToken: null });

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });

    expect(
      await testApp.dataSource
        .getRepository(ReservationEntity)
        .findOneByOrFail({ orderId: purchase.orderId }),
    ).toMatchObject({ status: 'CONSUMED', quantity: 1 });

    const idempotencyLogTypeOrmRepository =
      testApp.dataSource.getRepository(IdempotencyLogEntity);

    expect(
      (
        await idempotencyLogTypeOrmRepository.findBy({
          orderId: purchase.orderId,
          success: true,
        })
      )
        .map(({ step }) => step)
        .sort(),
    ).toEqual(Object.values(StepName).sort());

    const receivedEventLog = logs.mock.calls.find(
      ([, message]) => message === 'order.event.received',
    );

    expect(receivedEventLog?.[0]).toMatchObject({
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

    await testApp.orderMessaging.publish(
      testApp.checkoutTopic,
      purchase.orderId,
      outboxEvent.payload,
    );

    await testApp.orderMessaging.publish(
      testApp.checkoutTopic,
      purchase.orderId,
      outboxEvent.payload,
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

    expect(
      await idempotencyLogTypeOrmRepository.countBy({
        orderId: purchase.orderId,
      }),
    ).toBe(4);

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });

    const metricsService = await request(testApp.app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(metricsService.text).toContain(
      'shop_processing_total{result="completed"} 1',
    );

    expect(metricsService.text).toContain(
      'shop_processing_total{result="published"} 1',
    );

    expect(metricsService.text).toContain(
      'shop_checkout_total{result="replayed"} 1',
    );
  });

  it('resumes a transient email failure without repeating successful ERP or stock steps', async () => {
    const testApp = await setup({ EMAIL_FAILURES: 1 });

    const integrationSimulator = jest.spyOn(
      testApp.app.get(IntegrationSimulator),
      'execute',
    );

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    await testApp.outboxRelay.execute();

    const retrying = await waitForOrder(
      testApp,
      orderId,
      ProcessingStatus.Retrying,
      1,
    );

    expect(retrying.status).toBe(OrderStatus.Active);

    const retryOutboxEvent = await testApp.dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId, status: 'PENDING' });

    expect(orderEventSchema.parse(retryOutboxEvent.payload)).toMatchObject({
      kind: ORDER_CHECKOUT_INITIATED,
      meta: { attempt: 2 },
    });

    expect(
      retryOutboxEvent.availableAt.getTime() -
        retryOutboxEvent.createdAt.getTime(),
    ).toBeGreaterThanOrEqual(980);

    await waitUntil(async () => {
      const [row] = await testApp.dataSource.query(
        `SELECT available_at <= clock_timestamp() AS ready FROM outbox_events WHERE id = $1`,
        [retryOutboxEvent.id],
      );

      return row.ready === true;
    }, 'first retry backoff');

    await testApp.outboxRelay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 2);

    const idempotencyLogEntries = await testApp.dataSource
      .getRepository(IdempotencyLogEntity)
      .findBy({ orderId });

    expect(idempotencyLogEntries.filter(({ success }) => success)).toHaveLength(
      4,
    );

    expect(
      idempotencyLogEntries.filter(({ success }) => !success),
    ).toMatchObject([{ step: StepName.EmailNotificationStep }]);

    expect(
      integrationSimulator.mock.calls.filter(([kind]) => kind === 'erp'),
    ).toHaveLength(1);

    expect(
      integrationSimulator.mock.calls.filter(([kind]) => kind === 'email'),
    ).toHaveLength(2);

    expect(
      await testApp.dataSource
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

    await testApp.outboxRelay.execute();

    const order = await waitForOrder(
      testApp,
      orderId,
      ProcessingStatus.Retrying,
      1,
    );

    expect(order.status).toBe(OrderStatus.Pending);

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 10, reservedQuantity: 1 });

    expect(
      await testApp.dataSource
        .getRepository(ReservationEntity)
        .findOneByOrFail({ orderId }),
    ).toMatchObject({ status: 'ACTIVE' });

    expect(
      await testApp.dataSource
        .getRepository(IdempotencyLogEntity)
        .countBy({ orderId, success: true }),
    ).toBe(0);

    const retryOutboxEvent = await testApp.dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId, status: 'PENDING' });

    await makeAvailable(testApp, retryOutboxEvent.id);
    await testApp.outboxRelay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 2);

    expect(
      await testApp.dataSource
        .getRepository(IdempotencyLogEntity)
        .countBy({ orderId, success: true }),
    ).toBe(4);

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('exhausts five ERP attempts with exponential backoff and publishes a terminal DLQ event', async () => {
    const testApp = await setup({ ERP_FAILURES: 5, SIMULATOR_DELAY_MS: 0 });
    const deadLetters = await testApp.observe(`${testApp.checkoutTopic}.dlq`);

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    for (let attempt = 1; attempt <= 5; attempt += 1) {

      await testApp.outboxRelay.execute();
      const isTerminalAttempt = attempt === 5;

      const order = await waitForOrder(
        testApp,
        orderId,
        isTerminalAttempt ? ProcessingStatus.Failed : ProcessingStatus.Retrying,
        attempt,
      );

      expect(order.status).toBe(OrderStatus.Active);

      const nextOutboxEvent = await testApp.dataSource
        .getRepository(OutboxEventEntity)
        .findOneByOrFail({ orderId, status: 'PENDING' });

      expect(nextOutboxEvent.topic).toBe(
        isTerminalAttempt
          ? `${testApp.checkoutTopic}.dlq`
          : testApp.checkoutTopic,
      );

      if (!isTerminalAttempt) {

        const delayMs =
          nextOutboxEvent.availableAt.getTime() -
          nextOutboxEvent.createdAt.getTime();

        const expectedMs = 2 ** (attempt - 1) * 1000;

        expect(delayMs).toBeGreaterThanOrEqual(expectedMs - 20);
        expect(delayMs).toBeLessThan(expectedMs + 2000);

        expect(orderEventSchema.parse(nextOutboxEvent.payload)).toMatchObject({
          meta: { attempt: attempt + 1 },
        });

        await makeAvailable(testApp, nextOutboxEvent.id);

      }

    }

    await testApp.outboxRelay.execute();

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

    const idempotencyLogEntries = await testApp.dataSource
      .getRepository(IdempotencyLogEntity)
      .findBy({ orderId });

    expect(idempotencyLogEntries.filter(({ success }) => success)).toHaveLength(
      2,
    );

    expect(
      idempotencyLogEntries.filter(({ success }) => !success),
    ).toHaveLength(5);

    expect(
      idempotencyLogEntries
        .filter(({ success }) => !success)
        .every(({ step }) => step === StepName.UpdateErpStep),
    ).toBe(true);

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('dead-letters a permanent integration failure immediately without restoring consumed stock', async () => {
    const testApp = await setup({
      SIMULATOR_PERMANENT_FAILURE: 'erp',
      SIMULATOR_DELAY_MS: 0,
    });

    const deadLetters = await testApp.observe(`${testApp.checkoutTopic}.dlq`);

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    await testApp.outboxRelay.execute();

    const order = await waitForOrder(
      testApp,
      orderId,
      ProcessingStatus.Failed,
      1,
    );

    expect(order.status).toBe(OrderStatus.Active);
    await testApp.outboxRelay.execute();

    await waitUntil(
      async () => deadLetters.length === 1,
      'permanent error DLQ',
    );

    expect(deadLetters[0]!.message.key?.toString()).toBe(orderId);

    expect(
      await testApp.dataSource
        .getRepository(IdempotencyLogEntity)
        .findBy({ orderId, success: false }),
    ).toMatchObject([{ step: StepName.UpdateErpStep }]);

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('keeps an unpublished outbox event pending and recovers after the publisher fails', async () => {
    const testApp = await setup();
    const connect = jest.spyOn(testApp.orderMessaging, 'ensureConnected');

    const publish = jest
      .spyOn(testApp.orderMessaging, 'publish')
      .mockRejectedValueOnce(new Error('simulated broker outage'));

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    expect(connect).not.toHaveBeenCalled();
    await testApp.outboxRelay.execute();

    const pendingOutboxEvent = await testApp.dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId });

    expect(pendingOutboxEvent).toMatchObject({
      status: 'PENDING',
      leaseToken: null,
    });

    expect((await testApp.offsets())[0]?.offset).toBe('0');
    await makeAvailable(testApp, pendingOutboxEvent.id);
    await testApp.outboxRelay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 1);

    expect(publish).toHaveBeenCalledTimes(2);

    expect(
      await testApp.dataSource
        .getRepository(OutboxEventEntity)
        .findOneByOrFail({ id: pendingOutboxEvent.id }),
    ).toMatchObject({ status: 'PROCESSED', leaseToken: null });

    expect((await testApp.offsets())[0]?.offset).toBe('1');
  });

  it('reclaims an expired outbox lease and safely consumes a duplicate publication', async () => {
    const testApp = await setup();
    const { orderId } = await checkout(testApp);
    const outboxRepository = testApp.app.get(OutboxRepository);
    const claimedEvents = await outboxRepository.claim();

    expect(claimedEvents).toHaveLength(1);

    await testApp.orderMessaging.publish(
      testApp.checkoutTopic,
      orderId,
      claimedEvents[0]!.payload,
    );

    await testApp.dataSource.query(
      `UPDATE outbox_events SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [claimedEvents[0]!.id],
    );

    await testApp.outboxRelay.execute();
    expect((await testApp.offsets())[0]?.offset).toBe('2');
    await testApp.startConsumer();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 1);
    await testApp.waitForConsumerOffset(2);

    expect(
      await testApp.dataSource
        .getRepository(IdempotencyLogEntity)
        .countBy({ orderId, success: true }),
    ).toBe(4);

    expect(
      await testApp.dataSource
        .getRepository(StockEntity)
        .findOneByOrFail({ productId: product.id }),
    ).toMatchObject({ physicalQuantity: 9, reservedQuantity: 0 });
  });

  it('redelivers a message when persisting a failed activation temporarily fails', async () => {
    const testApp = await setup({ ERP_FAILURES: 1, SIMULATOR_DELAY_MS: 0 });
    const activationErrors = jest.spyOn(PinoLogger.prototype, 'error');
    const activationFailureHandler = testApp.app.get(ActivationFailureHandler);

    const handleActivationFailureMock = jest
      .spyOn(activationFailureHandler, 'handle')
      .mockRejectedValueOnce(
        Object.assign(new Error('simulated database outage'), {
          code: '57P01',
        }),
      );

    const deadLetters = await testApp.observe(`${testApp.checkoutTopic}.dlq`);

    await testApp.startConsumer();
    const { orderId, correlationId } = await checkout(testApp);

    await testApp.outboxRelay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Retrying, 1);

    expect(handleActivationFailureMock).toHaveBeenCalledTimes(2);
    expect(deadLetters).toHaveLength(0);

    const failureLog = activationErrors.mock.calls.find(
      ([, message]) => message === 'order.event.dispatch.failed',
    );

    expect(failureLog?.[0]).toMatchObject({
      correlation_id: correlationId,
      order_id: orderId,
      trace_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      context: [{ error_type: 'Error' }],
    });

    const retryOutboxEvent = await testApp.dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ orderId, status: 'PENDING' });

    await makeAvailable(testApp, retryOutboxEvent.id);
    await testApp.outboxRelay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 2);
    expect(deadLetters).toHaveLength(0);
  });

  it('redelivers a message after a transient Kafka failure in its handler', async () => {
    const testApp = await setup({ SIMULATOR_DELAY_MS: 0 });
    const deadLetters = await testApp.observe(`${testApp.checkoutTopic}.dlq`);

    const checkoutInitiatedExecuteMock = jest
      .spyOn(testApp.app.get(CheckoutInitiatedHandler), 'execute')
      .mockRejectedValueOnce(new KafkaJSError('simulated broker outage'));

    await testApp.startConsumer();
    const { orderId } = await checkout(testApp);

    await testApp.outboxRelay.execute();
    await waitForOrder(testApp, orderId, ProcessingStatus.Completed, 1);
    await testApp.waitForConsumerOffset(1);

    expect(checkoutInitiatedExecuteMock).toHaveBeenCalledTimes(2);
    expect(deadLetters).toHaveLength(0);
  });

  it('dead-letters an invalid event safely and retries a failed DLQ publication', async () => {
    const testApp = await setup();
    const deadLetters = await testApp.observe(`${testApp.checkoutTopic}.dlq`);

    await testApp.startConsumer();

    const originalPublish = testApp.orderMessaging.publish.bind(
      testApp.orderMessaging,
    );

    let dlqAttempts = 0;

    const publish = jest
      .spyOn(testApp.orderMessaging, 'publish')
      .mockImplementation(async (topic, key, payload, headers) => {
        if (topic === `${testApp.checkoutTopic}.dlq` && ++dlqAttempts === 1) {

          throw new Error('simulated DLQ outage');

        }

        return originalPublish(topic, key, payload, headers);
      });

    await testApp.orderMessaging.publish(testApp.checkoutTopic, 'invalid', {
      secret: 'private-test-value',
      kind: 'UNKNOWN',
    });

    await waitUntil(async () => deadLetters.length === 1, 'invalid event DLQ');
    await testApp.waitForConsumerOffset(1);

    const message = deadLetters[0]!.message;
    const deadLetterPayload = message.value!.toString();

    expect(dlqAttempts).toBe(2);
    expect(publish).toHaveBeenCalledTimes(3);

    expect(message.headers?.['x-dlq-reason']?.toString()).toBe(
      'Invalid event payload',
    );

    expect(message.headers?.['x-source-topic']?.toString()).toBe(
      testApp.checkoutTopic,
    );

    expect(message.headers?.['x-source-partition']?.toString()).toBe('0');
    expect(message.headers?.['x-source-offset']?.toString()).toBe('0');

    expect(message.headers?.['x-event-kind']?.toString()).toBe('UNKNOWN');

    expect(JSON.parse(deadLetterPayload)).toEqual({
      kind: 'UNKNOWN',
      source: { topic: testApp.checkoutTopic, partition: 0, offset: '0' },
      reason: 'Invalid event payload',
    });

    expect(deadLetterPayload).not.toContain('private-test-value');
    expect(deadLetterPayload).not.toContain('secret');

    await testApp.orderMessaging.publish(
      testApp.checkoutTopic,
      'invalid-known-kind',
      {
        kind: ORDER_RESERVATION_EXPIRED,
        data: { order_id: 'invalid-id' },
        secret: 'private-test-value',
      },
    );

    await waitUntil(async () => deadLetters.length === 2, 'second invalid DLQ');
    await testApp.waitForConsumerOffset(2);
    const secondDeadLetterMessage = deadLetters[1]!.message;

    expect(secondDeadLetterMessage.headers?.['x-event-kind']?.toString()).toBe(
      ORDER_RESERVATION_EXPIRED,
    );

    expect(JSON.parse(secondDeadLetterMessage.value!.toString())).toEqual({
      kind: ORDER_RESERVATION_EXPIRED,
      source: { topic: testApp.checkoutTopic, partition: 0, offset: '1' },
      reason: 'Invalid event payload',
    });

    expect(secondDeadLetterMessage.value!.toString()).not.toContain(
      'private-test-value',
    );
  });

  it.each([ORDER_CHECKOUT_INITIATED, ORDER_RESERVATION_EXPIRED])(
    'dead-letters an unexpected %s handler error with its kind and payload',
    async (kind) => {
      const testApp = await setup();
      const deadLetters = await testApp.observe(`${testApp.checkoutTopic}.dlq`);

      if (kind === ORDER_CHECKOUT_INITIATED) {

        jest
          .spyOn(testApp.app.get(CheckoutInitiatedHandler), 'execute')
          .mockRejectedValueOnce(new TypeError('simulated programming error'));

      } else {

        jest
          .spyOn(testApp.app.get(ReservationExpiredHandler), 'handle')
          .mockRejectedValueOnce(new TypeError('simulated programming error'));

      }

      await testApp.startConsumer();
      const { orderId } = await checkout(testApp);

      const event = {
        kind,
        data: { order_id: orderId },
        meta:
          kind === ORDER_CHECKOUT_INITIATED
            ? { ...createEventMeta(randomUUID()), attempt: 1 }
            : createEventMeta(randomUUID()),
      };

      await testApp.orderMessaging.publish(
        testApp.checkoutTopic,
        orderId,
        event,
      );

      await waitUntil(async () => deadLetters.length === 1, 'unexpected DLQ');
      await testApp.waitForConsumerOffset(1);

      const message = deadLetters[0]!.message;

      expect(message.key?.toString()).toBe(orderId);

      expect(message.headers?.['x-dlq-reason']?.toString()).toBe(
        'Unexpected TypeError',
      );

      expect(message.headers?.['x-event-kind']?.toString()).toBe(kind);
      expect(message.headers?.['x-error-type']?.toString()).toBe('TypeError');
      expect(JSON.parse(message.value!.toString())).toEqual(event);

      expect(
        await testApp.dataSource.getRepository(OrderEntity).findOneByOrFail({
          id: orderId,
        }),
      ).toMatchObject({
        status: OrderStatus.Pending,
        processingStatus: ProcessingStatus.Pending,
      });
    },
  );

  it('dead-letters a valid event that refers to an unknown order as a permanent error', async () => {
    const testApp = await setup();
    const deadLetters = await testApp.observe(`${testApp.checkoutTopic}.dlq`);

    await testApp.startConsumer();
    const orderId = randomUUID();

    const event = {
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: orderId },
      meta: { ...createEventMeta(randomUUID()), attempt: 1 },
    };

    await testApp.orderMessaging.publish(testApp.checkoutTopic, orderId, event);
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
      await testApp.dataSource.getRepository(OutboxEventEntity).count(),
    ).toBe(0);
  });
});
