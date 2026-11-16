import { BadRequestException } from '@nestjs/common';
import { CheckoutGuard } from '@app/order/adapters/usecases/guards/checkout.guard';
import { CheckoutInput } from '@app/order/domain/dto/create-order.dto';
import {
  Environment,
  PaymentType,
} from '@app/order/domain/shared/types/order.type';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import {
  CATALOG_KEY,
  GetProductsUseCase,
} from '@app/products/adapters/usecases/get-products.use-case';
import { ProductRepository } from '@app/products/repositories/product.repository';
import { InMemoryRedisConnection } from '../integration/support/in-memory-redis';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as AppLogger;

const productId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function catalogRow(n: number) {
  return {
    id: productId(n),
    name: `Case ${n}`,
    productKey: `CASE-${n}`,
    netPrice: '1000',
    listPrice: '1500',
  };
}

async function cacheCounts(metrics: Metrics) {
  const { values } = await metrics.cache.get();

  return Object.fromEntries(values.map((v) => [v.labels.result, v.value]));
}

describe('GetProductsUseCase', () => {
  function build(findAll: jest.Mock, redis = new InMemoryRedisConnection()) {
    const metrics = new Metrics();

    const useCase = new GetProductsUseCase(
      { findAll } as unknown as ProductRepository,
      redis as unknown as RedisConnection,
      metrics,
      new Spans(logger),
      logger,
    );

    return { useCase, metrics, redis };
  }

  it('loads once for concurrent misses and serves later reads from cache', async () => {
    const findAll = jest.fn().mockResolvedValue([catalogRow(1)]);
    const { useCase, metrics, redis } = build(findAll);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => useCase.execute()),
    );

    expect(findAll).toHaveBeenCalledTimes(1);

    expect(
      results.every((r) => r.length === 1 && r[0]?.netPrice === 1000),
    ).toBe(true);

    expect(redis.client.ttlSeconds(CATALOG_KEY)).toBeGreaterThan(290);

    await useCase.execute();

    expect(findAll).toHaveBeenCalledTimes(1);
    expect(await cacheCounts(metrics)).toMatchObject({ hit: 1, miss: 20 });
  });

  it('treats a malformed cache entry as a miss and rewrites it', async () => {
    const findAll = jest.fn().mockResolvedValue([catalogRow(2)]);
    const { useCase, metrics, redis } = build(findAll);

    await redis.client.set(CATALOG_KEY, '{not json');

    const [product] = await useCase.execute();

    expect(product?.productKey).toBe('CASE-2');
    expect(findAll).toHaveBeenCalledTimes(1);
    expect((await cacheCounts(metrics)).invalid).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the database when Redis is unavailable', async () => {
    const findAll = jest.fn().mockResolvedValue([catalogRow(3)]);
    const redis = new InMemoryRedisConnection();

    jest.spyOn(redis.client, 'get').mockRejectedValue(new Error('down'));

    const { useCase, metrics } = build(findAll, redis);

    await Promise.all([useCase.execute(), useCase.execute()]);

    expect(findAll).toHaveBeenCalledTimes(1);
    expect((await cacheCounts(metrics)).unavailable).toBe(2);
  });

  it('maps repository failures to 503 without caching anything', async () => {
    const findAll = jest.fn().mockRejectedValue(new Error('db down'));
    const { useCase, redis } = build(findAll);

    await expect(useCase.execute()).rejects.toMatchObject({ status: 503 });
    expect(redis.client.has(CATALOG_KEY)).toBe(false);
  });
});

describe('CheckoutGuard', () => {
  const guard = new CheckoutGuard();

  const base: CheckoutInput = {
    paymentType: PaymentType.PrePaid,
    dueDate: '2026-11-10',
    mainContact: 'customer@example.test',
    paymentMethod: 'PIX',
    environment: Environment.Local,
    items: [
      { productId: productId(1), quantity: 1 },
      { productId: productId(2), quantity: 2 },
    ],
  };

  it.each([undefined, '', 'has space', 'x'.repeat(129)])(
    'rejects invalid idempotency key %p',
    (key) => {
      expect(() => guard.validate(base, key)).toThrow(BadRequestException);
    },
  );

  it('rejects duplicate products in a cart', () => {
    const duplicated = {
      ...base,
      items: [base.items[0]!, base.items[0]!],
    };

    expect(() => guard.validate(duplicated, 'key-1')).toThrow(
      'Duplicate products',
    );
  });

  it('hashes equivalent carts identically regardless of item order or null altContact', () => {
    const reordered = {
      ...base,
      altContact: undefined,
      items: [...base.items].reverse(),
    };

    expect(guard.hashPayload(reordered)).toBe(guard.hashPayload(base));
  });

  it('changes the hash when any purchase field changes', () => {
    const changed = {
      ...base,
      items: [{ ...base.items[0]!, quantity: 5 }, base.items[1]!],
    };

    expect(guard.hashPayload(changed)).not.toBe(guard.hashPayload(base));

    expect(guard.hashPayload({ ...base, paymentMethod: 'CARD' })).not.toBe(
      guard.hashPayload(base),
    );
  });
});
