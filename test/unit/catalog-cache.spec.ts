import { BadRequestException } from '@nestjs/common';
import { CheckoutGuard } from '@app/order/adapters/usecases/guards/checkout.guard';
import { CheckoutDto } from '@app/order/domain/dto/create-order.dto';
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
  CATALOG_LOCK,
  GetProductsUseCase,
} from '@app/products/adapters/usecases/get-products.use-case';
import { ProductRepository } from '@app/products/repositories/product.repository';
import { InMemoryRedisConnection } from '../integration/support/in-memory-redis';

const appLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as AppLogger;

const productId = (productNumber: number) =>
  `00000000-0000-4000-8000-00000000000${productNumber}`;

function catalogRow(productNumber: number) {
  return {
    id: productId(productNumber),
    name: `Case ${productNumber}`,
    productKey: `CASE-${productNumber}`,
    netPrice: '1000',
    listPrice: '1500',
  };
}

async function cacheCounts(metricsService: Metrics) {
  const { values } = await metricsService.cacheRequestsCounter.get();

  return Object.fromEntries(
    values.map((metricSample) => [
      metricSample.labels.result,
      metricSample.value,
    ]),
  );
}

describe('GetProductsUseCase', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function build(
    findAllProductsMock: jest.Mock,
    redisConnection = new InMemoryRedisConnection(),
  ) {
    const metricsService = new Metrics();

    const getProductsUseCase = new GetProductsUseCase(
      { findAll: findAllProductsMock } as unknown as ProductRepository,
      redisConnection as unknown as RedisConnection,
      metricsService,
      new Spans(appLogger),
      appLogger,
    );

    return { getProductsUseCase, metricsService, redisConnection };
  }

  it('loads once for concurrent misses and serves later reads from cache', async () => {
    const findAllProductsMock = jest.fn().mockResolvedValue([catalogRow(1)]);

    const { getProductsUseCase, metricsService, redisConnection } =
      build(findAllProductsMock);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => getProductsUseCase.execute()),
    );

    expect(findAllProductsMock).toHaveBeenCalledTimes(1);

    expect(
      results.every(
        (catalogProducts) =>
          catalogProducts.length === 1 && catalogProducts[0]?.netPrice === 1000,
      ),
    ).toBe(true);

    expect(redisConnection.redisClient.ttlSeconds(CATALOG_KEY)).toBeGreaterThan(
      290,
    );

    await getProductsUseCase.execute();

    expect(findAllProductsMock).toHaveBeenCalledTimes(1);

    expect(await cacheCounts(metricsService)).toMatchObject({
      hit: 1,
      miss: 20,
    });
  });

  it('treats a malformed cache entry as a miss and rewrites it', async () => {
    const findAllProductsMock = jest.fn().mockResolvedValue([catalogRow(2)]);

    const { getProductsUseCase, metricsService, redisConnection } =
      build(findAllProductsMock);

    await redisConnection.redisClient.set(CATALOG_KEY, '{not json');

    const [product] = await getProductsUseCase.execute();

    expect(product?.productKey).toBe('CASE-2');
    expect(findAllProductsMock).toHaveBeenCalledTimes(1);

    expect((await cacheCounts(metricsService)).invalid).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('falls back to the database when Redis is unavailable', async () => {
    const findAllProductsMock = jest.fn().mockResolvedValue([catalogRow(3)]);
    const redisConnection = new InMemoryRedisConnection();

    jest
      .spyOn(redisConnection.redisClient, 'get')
      .mockRejectedValue(new Error('down'));

    const { getProductsUseCase, metricsService } = build(
      findAllProductsMock,
      redisConnection,
    );

    await Promise.all([
      getProductsUseCase.execute(),
      getProductsUseCase.execute(),
    ]);

    expect(findAllProductsMock).toHaveBeenCalledTimes(1);
    expect((await cacheCounts(metricsService)).unavailable).toBe(2);
  });

  it('maps repository failures to 503 without caching anything', async () => {
    const findAllProductsMock = jest
      .fn()
      .mockRejectedValue(new Error('db down'));

    const { getProductsUseCase, redisConnection } = build(findAllProductsMock);

    await expect(getProductsUseCase.execute()).rejects.toMatchObject({
      status: 503,
    });

    expect(redisConnection.redisClient.has(CATALOG_KEY)).toBe(false);
  });

  it('caches an empty catalog and serves it without reloading', async () => {
    const findAll = jest.fn().mockResolvedValue([]);
    const { getProductsUseCase } = build(findAll);

    await expect(getProductsUseCase.execute()).resolves.toEqual([]);
    await expect(getProductsUseCase.execute()).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalledTimes(1);
  });

  it('rejects valid JSON with an invalid catalog shape and replaces it', async () => {
    const findAll = jest.fn().mockResolvedValue([catalogRow(1)]);

    const { getProductsUseCase, redisConnection, metricsService } =
      build(findAll);

    await redisConnection.redisClient.set(
      CATALOG_KEY,
      JSON.stringify([{ ...catalogRow(1), unexpected: true }]),
    );

    await expect(getProductsUseCase.execute()).resolves.toMatchObject([
      { netPrice: 1000, listPrice: 1500 },
    ]);

    expect((await cacheCounts(metricsService)).invalid).toBeGreaterThan(0);
    expect(findAll).toHaveBeenCalledTimes(1);
  });

  it('releases the cache lock after a failed load and permits a later retry', async () => {
    const findAll = jest
      .fn()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue([catalogRow(1)]);

    const { getProductsUseCase, redisConnection } = build(findAll);

    await expect(getProductsUseCase.execute()).rejects.toMatchObject({
      status: 503,
    });

    expect(redisConnection.redisClient.has(CATALOG_LOCK)).toBe(false);
    await expect(getProductsUseCase.execute()).resolves.toHaveLength(1);
    expect(findAll).toHaveBeenCalledTimes(2);
  });

  it('returns products even when cache write and unlock fail', async () => {
    const findAll = jest.fn().mockResolvedValue([catalogRow(1)]);
    const { getProductsUseCase, redisConnection } = build(findAll);

    jest
      .spyOn(redisConnection.redisClient, 'eval')
      .mockRejectedValue(new Error('Redis unavailable'));

    await expect(getProductsUseCase.execute()).resolves.toHaveLength(1);
    expect(appLogger.warn).toHaveBeenCalledWith('catalog.cache.write.failed');
    expect(appLogger.warn).toHaveBeenCalledWith('catalog.cache.unlock.failed');
  });

  it('falls back to the repository if lock acquisition fails', async () => {
    const findAll = jest.fn().mockResolvedValue([catalogRow(1)]);
    const { getProductsUseCase, redisConnection } = build(findAll);

    jest
      .spyOn(redisConnection.redisClient, 'set')
      .mockRejectedValue(new Error('Redis unavailable'));

    await expect(getProductsUseCase.execute()).resolves.toHaveLength(1);
    expect(appLogger.warn).toHaveBeenCalledWith('catalog.cache.unavailable');
  });

  it('waits for another loader and uses its result without loading the database', async () => {
    const findAll = jest.fn();
    const { getProductsUseCase, redisConnection } = build(findAll);

    jest.useFakeTimers();

    await redisConnection.redisClient.set(CATALOG_LOCK, 'another-loader', {
      PX: 5000,
    });

    const operation = getProductsUseCase.execute();

    await jest.advanceTimersByTimeAsync(50);

    await redisConnection.redisClient.set(
      CATALOG_KEY,
      JSON.stringify([{ ...catalogRow(1), netPrice: 1000, listPrice: 1500 }]),
    );

    await jest.advanceTimersByTimeAsync(50);
    await expect(operation).resolves.toHaveLength(1);
    expect(findAll).not.toHaveBeenCalled();
  });

  it('returns 503 after the refresh deadline when another loader keeps the lock', async () => {
    const findAll = jest.fn();
    const { getProductsUseCase, redisConnection } = build(findAll);

    jest.useFakeTimers();

    await redisConnection.redisClient.set(CATALOG_LOCK, 'another-loader', {
      PX: 10000,
    });

    const rejected = expect(getProductsUseCase.execute()).rejects.toMatchObject(
      { status: 503 },
    );

    await jest.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(findAll).not.toHaveBeenCalled();

    expect(await redisConnection.redisClient.get(CATALOG_LOCK)).toBe(
      'another-loader',
    );
  });
});

describe('CheckoutGuard', () => {
  const checkoutGuard = new CheckoutGuard();

  const checkoutDto: CheckoutDto = {
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
    (idempotencyKey) => {
      expect(() => checkoutGuard.validate(checkoutDto, idempotencyKey)).toThrow(
        BadRequestException,
      );
    },
  );

  it('rejects duplicate products in a cart', () => {
    const duplicateProductInput = {
      ...checkoutDto,
      items: [checkoutDto.items[0]!, checkoutDto.items[0]!],
    };

    expect(() =>
      checkoutGuard.validate(duplicateProductInput, 'key-1'),
    ).toThrow('Duplicate products');
  });

  it('hashes equivalent carts identically regardless of item order or null altContact', () => {
    const reorderedInput = {
      ...checkoutDto,
      altContact: undefined,
      items: [...checkoutDto.items].reverse(),
    };

    expect(checkoutGuard.hashPayload(reorderedInput)).toBe(
      checkoutGuard.hashPayload(checkoutDto),
    );
  });

  it('changes the hash when any purchase field changes', () => {
    const changedQuantityInput = {
      ...checkoutDto,
      items: [{ ...checkoutDto.items[0]!, quantity: 5 }, checkoutDto.items[1]!],
    };

    expect(checkoutGuard.hashPayload(changedQuantityInput)).not.toBe(
      checkoutGuard.hashPayload(checkoutDto),
    );

    expect(
      checkoutGuard.hashPayload({ ...checkoutDto, paymentMethod: 'CARD' }),
    ).not.toBe(checkoutGuard.hashPayload(checkoutDto));
  });
});
