import {
  createRealServicesTestApp,
  RealServicesTestApp,
  seedProduct,
  waitUntil,
} from './support/real-services-test-app';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Spans } from '@app/platform/observability/spans';
import {
  CATALOG_KEY,
  CATALOG_LOCK,
  GetProductsUseCase,
} from '@app/products/adapters/usecases/get-products.use-case';
import { ProductEntity } from '@app/products/domain/entities';
import { ProductRepository } from '@app/products/repositories/product.repository';
import { newProduct, ProductRecord } from './support/in-memory-store';

describe('Catalog with PostgreSQL and Redis (integration)', () => {
  let testContext: RealServicesTestApp | undefined;
  let product: ProductRecord;

  beforeEach(async () => {
    testContext = await createRealServicesTestApp();
    product = await seedProduct(testContext.dataSource, newProduct());
  });

  afterEach(async () => {
    await testContext?.close();
    testContext = undefined;
  });

  it('uses the real cache with a 300-second TTL, invalidation and malformed-value recovery', async () => {
    const testApp = testContext!;
    const logs = jest.spyOn(PinoLogger.prototype, 'info');
    const correlationId = randomUUID();

    const firstCatalogResponse = await request(testApp.app.getHttpServer())
      .get('/products')
      .set('X-Correlation-Id', correlationId)
      .expect(200);

    expect(firstCatalogResponse.body).toMatchObject([
      { id: product.id, netPrice: 2990 },
    ]);

    const catalogSpan = logs.mock.calls.find(
      ([fields, message]) =>
        message === 'trace.span' &&
        typeof fields === 'object' &&
        fields !== null &&
        'name' in fields &&
        fields.name === 'catalog.get',
    )?.[0];

    const repositorySpan = logs.mock.calls.find(
      ([fields, message]) =>
        message === 'trace.span' &&
        typeof fields === 'object' &&
        fields !== null &&
        'name' in fields &&
        fields.name === 'catalog.repository',
    )?.[0];

    expect(catalogSpan).toMatchObject({
      correlation_id: correlationId,
      trace_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      span_id: expect.stringMatching(/^[a-f0-9]{16}$/),
    });

    if (
      typeof catalogSpan !== 'object' ||
      catalogSpan === null ||
      !('trace_id' in catalogSpan) ||
      !('span_id' in catalogSpan)
    ) {

      throw new Error('Catalog span is missing trace context');

    }

    expect(repositorySpan).toMatchObject({
      correlation_id: correlationId,
      trace_id: catalogSpan.trace_id,
      parent_span_id: catalogSpan.span_id,
    });

    const ttl = await testApp.redisConnection.redisClient.ttl(CATALOG_KEY);

    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);

    await testApp.dataSource
      .getRepository(ProductEntity)
      .update({ id: product.id }, { netPrice: 4990 });

    const cached = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(cached.body).toEqual(firstCatalogResponse.body);
    await testApp.redisConnection.redisClient.expire(CATALOG_KEY, 1);

    await waitUntil(
      async () =>
        (await testApp.redisConnection.redisClient.exists(CATALOG_KEY)) === 0,
      'catalog TTL expiration',
    );

    const refreshed = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(refreshed.body).toMatchObject([{ id: product.id, netPrice: 4990 }]);
    await testApp.redisConnection.redisClient.set(CATALOG_KEY, '{not-json');

    const recovered = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(recovered.body).toEqual(refreshed.body);

    expect(
      JSON.parse((await testApp.redisConnection.redisClient.get(CATALOG_KEY))!),
    ).toEqual(refreshed.body);

    const metricsService = await request(testApp.app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(metricsService.text).toContain(
      'shop_cache_requests_total{result="hit"} 1',
    );

    expect(metricsService.text).toContain(
      'shop_cache_requests_total{result="miss"} 3',
    );

    expect(metricsService.text).toMatch(
      /shop_cache_requests_total\{result="invalid"\} [1-9]\d*/,
    );
  });

  it('coordinates cache misses across independent instances using a Redis lock', async () => {
    const testApp = testContext!;
    const productRepository = testApp.app.get(ProductRepository);
    const findAllProducts = productRepository.findAll.bind(productRepository);

    const findAllProductsMock = jest
      .spyOn(productRepository, 'findAll')
      .mockImplementation(async () => {
        await delay(150);

        return findAllProducts();
      });

    const redisConnection = new RedisConnection(
      testApp.app.get(ConfigService),
      testApp.app.get(AppLogger),
    );

    redisConnection.onModuleInit();

    try {

      await waitUntil(
        async () => redisConnection.redisClient.isReady,
        'replica Redis',
      );

      const primaryGetProductsUseCase = testApp.app.get(GetProductsUseCase);

      const secondaryGetProductsUseCase = new GetProductsUseCase(
        productRepository,
        redisConnection,
        testApp.metricsService,
        testApp.app.get(Spans),
        testApp.app.get(AppLogger),
      );

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 === 0
            ? primaryGetProductsUseCase
            : secondaryGetProductsUseCase
          ).execute(),
        ),
      );

      expect(findAllProductsMock).toHaveBeenCalledTimes(1);

      expect(results.every((catalog) => catalog[0]?.id === product.id)).toBe(
        true,
      );

      expect(
        await testApp.redisConnection.redisClient.exists(CATALOG_KEY),
      ).toBe(1);

      expect(
        await testApp.redisConnection.redisClient.exists(CATALOG_LOCK),
      ).toBe(0);

    } finally {

      redisConnection.onModuleDestroy();

    }
  });

  it('recovers when a previous cache owner abandons its expiring lock', async () => {
    const testApp = testContext!;

    await testApp.redisConnection.redisClient.set(CATALOG_LOCK, 'abandoned', {
      PX: 200,
    });

    const response = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(response.body).toMatchObject([{ id: product.id }]);

    expect(await testApp.redisConnection.redisClient.exists(CATALOG_KEY)).toBe(
      1,
    );

    expect(await testApp.redisConnection.redisClient.exists(CATALOG_LOCK)).toBe(
      0,
    );
  });

  it('falls back to PostgreSQL when its disposable Redis container stops', async () => {
    const testApp = testContext!;

    await testApp.stopRedis();

    await waitUntil(
      async () => !testApp.redisConnection.redisClient.isReady,
      'Redis outage',
    );

    const response = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(response.body).toMatchObject([{ id: product.id, netPrice: 2990 }]);

    const metricsService = await request(testApp.app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(metricsService.text).toContain(
      'shop_cache_requests_total{result="unavailable"} 1',
    );

    jest
      .spyOn(testApp.app.get(ProductRepository), 'findAll')
      .mockRejectedValueOnce(new Error('database connection failed'));

    const unavailable = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(503);

    expect(unavailable.body.message).toBe('Catalog temporarily unavailable');

    expect(JSON.stringify(unavailable.body)).not.toContain(
      'database connection',
    );
  });
});
