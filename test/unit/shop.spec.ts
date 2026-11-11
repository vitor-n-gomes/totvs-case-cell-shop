import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckoutInput, checkoutEventSchema } from '@app/contracts';
import { checkoutHash } from '@app/shop/orders/checkout';
import { CheckoutDto } from '../../apps/api/src/shop/shop.dto';
import {
  sanitizePayload,
  RequestAuditRepository,
} from '@app/platform/observability/request-audit';
import { Metrics } from '@app/platform/observability/metrics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { IntegrationSimulator } from '@app/shop/activation/steps/integration-steps';
import { ActivationContext } from '@app/shop/activation/steps/activation-step';
import {
  PermanentActivationError,
  IntegrationTimeoutError,
} from '@app/shop/activation/guards/activation-errors';
import { DataSource } from 'typeorm';

const input = (): CheckoutInput => ({
  paymentType: 'PREPAID',
  dueDate: '2026-11-10',
  mainContact: 'customer@example.test',
  paymentMethod: 'PIX',
  environment: 'LOCAL',
  items: [{ productId: randomUUID(), quantity: 1 }],
});
describe('Checkout contracts', () => {
  it('hashes item order and object key order canonically', () => {
    const original = input();
    original.items.push({ productId: randomUUID(), quantity: 2 });
    expect(checkoutHash(original)).toBe(
      checkoutHash({
        ...original,
        items: original.items
          .toReversed()
          .map(({ productId, quantity }) => ({ quantity, productId })),
      }),
    );
    expect(checkoutHash(original)).not.toBe(
      checkoutHash({ ...original, paymentMethod: 'CARD' }),
    );
  });
  it.each([
    { dueDate: '2026-02-30' },
    { dueDate: '2026-11-10T10:00:00Z' },
    { mainContact: ' ' },
    { paymentType: 'OTHER' },
    { items: [] },
    { items: [{ productId: 'invalid', quantity: 0 }] },
    { extra: true },
  ])('rejects malformed checkout %j', async (change) => {
    expect(
      (
        await validate(
          plainToInstance(CheckoutDto, { ...input(), ...change }),
          { whitelist: true, forbidNonWhitelisted: true },
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('validates complete checkout and rejects invalid event attempts', async () => {
    expect(await validate(plainToInstance(CheckoutDto, input()))).toEqual([]);
    expect(
      checkoutEventSchema.safeParse({
        schema_version: 1,
        event_id: randomUUID(),
        order_id: randomUUID(),
        correlation_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        attempt: 6,
        trace_id: 'a'.repeat(32),
        parent_span_id: 'b'.repeat(16),
      }).success,
    ).toBe(false);
  });
});
describe('Request audit', () => {
  const logger = { warn: jest.fn(), info: jest.fn() } as unknown as AppLogger;
  it('redacts contacts, credentials and nested sensitive payloads', () => {
    expect(
      sanitizePayload({
        mainContact: 'secret',
        nested: { token: 'secret', quantity: 2 },
        items: [{ cardNumber: 'secret' }],
      }),
    ).toEqual({
      mainContact: '[redacted]',
      nested: { token: '[redacted]', quantity: 2 },
      items: [{ cardNumber: '[redacted]' }],
    });
  });
  it('bounds its queue, drains on shutdown and counts overflow', async () => {
    const database = { query: jest.fn().mockResolvedValue([]) };
    const metrics = new Metrics();
    const audit = new RequestAuditRepository(
      database as unknown as DataSource,
      metrics,
      logger,
    );
    for (let i = 0; i < 1001; i++)
      audit.enqueue({
        url: '/checkout',
        method: 'POST',
        payload: {},
        correlationId: randomUUID(),
      });
    expect(database.query).not.toHaveBeenCalled();
    await audit.beforeApplicationShutdown();
    expect(database.query).toHaveBeenCalledTimes(1000);
    expect(await metrics.registry.metrics()).toContain(
      'shop_request_log_total{result="dropped"} 1',
    );
  });
  it('contains persistence failures without rejecting HTTP work', async () => {
    const metrics = new Metrics();
    const audit = new RequestAuditRepository(
      {
        query: jest.fn().mockRejectedValue(new Error('down')),
      } as unknown as DataSource,
      metrics,
      logger,
    );
    audit.enqueue({
      url: '/checkout',
      method: 'POST',
      payload: {},
      correlationId: randomUUID(),
    });
    await expect(audit.beforeApplicationShutdown()).resolves.toBeUndefined();
    expect(await metrics.registry.metrics()).toContain(
      'shop_request_log_total{result="failed"} 1',
    );
  });
});
describe('Integration simulation', () => {
  const context = {
    order: { id: randomUUID() },
    event: { attempt: 1 },
  } as ActivationContext;
  const make = (changes: Record<string, unknown> = {}) =>
    new IntegrationSimulator(
      new ConfigService({
        SIMULATOR_TIMEOUT_MS: 10,
        SIMULATOR_DELAY_MS: 0,
        SIMULATOR_PERMANENT_FAILURE: 'none',
        ERP_FAILURES: 0,
        EMAIL_FAILURES: 0,
        ...changes,
      }),
      { info: jest.fn() } as unknown as AppLogger,
    );
  it('simulates bounded transient failures', async () => {
    await expect(
      make({ ERP_FAILURES: 1 }).execute('erp', context),
    ).rejects.toThrow('transient');
    await expect(
      make({ ERP_FAILURES: 1 }).execute('erp', {
        ...context,
        event: { ...context.event, attempt: 2 },
      }),
    ).resolves.toBeUndefined();
  });
  it('classifies permanent failures and timeouts', async () => {
    await expect(
      make({ SIMULATOR_PERMANENT_FAILURE: 'erp' }).execute('erp', context),
    ).rejects.toBeInstanceOf(PermanentActivationError);
    await expect(
      make({ SIMULATOR_DELAY_MS: 20 }).execute('email', context),
    ).rejects.toBeInstanceOf(IntegrationTimeoutError);
  });
});
