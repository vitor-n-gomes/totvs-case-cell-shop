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
  let context: RealServicesTestApp | undefined;
  let product: ProductRecord;

  beforeEach(async () => {
    context = await createRealServicesTestApp();
    product = await seedProduct(context.database, newProduct());
  });

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  it('uses the real cache with a 300-second TTL, invalidation and malformed-value recovery', async () => {
    const testApp = context!;
    const logs = jest.spyOn(PinoLogger.prototype, 'info');
    const correlationId = randomUUID();

    const first = await request(testApp.app.getHttpServer())
      .get('/products')
      .set('x-correlation-id', correlationId)
      .expect(200);

    expect(first.body).toMatchObject([{ id: product.id, netPrice: 2990 }]);

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

    const ttl = await testApp.redis.client.ttl(CATALOG_KEY);

    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);

    await testApp.database
      .getRepository(ProductEntity)
      .update({ id: product.id }, { netPrice: 4990 });

    const cached = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(cached.body).toEqual(first.body);
    await testApp.redis.client.expire(CATALOG_KEY, 1);

    await waitUntil(
      async () => (await testApp.redis.client.exists(CATALOG_KEY)) === 0,
      'catalog TTL expiration',
    );

    const refreshed = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(refreshed.body).toMatchObject([{ id: product.id, netPrice: 4990 }]);
    await testApp.redis.client.set(CATALOG_KEY, '{not-json');

    const recovered = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(recovered.body).toEqual(refreshed.body);

    expect(JSON.parse((await testApp.redis.client.get(CATALOG_KEY))!)).toEqual(
      refreshed.body,
    );

    const metrics = await request(testApp.app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(metrics.text).toContain('shop_cache_requests_total{result="hit"} 1');

    expect(metrics.text).toContain(
      'shop_cache_requests_total{result="miss"} 3',
    );

    expect(metrics.text).toMatch(
      /shop_cache_requests_total\{result="invalid"\} [1-9]\d*/,
    );
  });

  it('coordinates cache misses across independent instances using a Redis lock', async () => {
    const testApp = context!;
    const repository = testApp.app.get(ProductRepository);
    const findAll = repository.findAll.bind(repository);

    const load = jest
      .spyOn(repository, 'findAll')
      .mockImplementation(async () => {
        await delay(150);

        return findAll();
      });

    const replicaRedis = new RedisConnection(
      testApp.app.get(ConfigService),
      testApp.app.get(AppLogger),
    );

    replicaRedis.onModuleInit();

    try {

      await waitUntil(async () => replicaRedis.client.isReady, 'replica Redis');
      const first = testApp.app.get(GetProductsUseCase);

      const second = new GetProductsUseCase(
        repository,
        replicaRedis,
        testApp.metrics,
        testApp.app.get(Spans),
        testApp.app.get(AppLogger),
      );

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 === 0 ? first : second).execute(),
        ),
      );

      expect(load).toHaveBeenCalledTimes(1);

      expect(results.every((catalog) => catalog[0]?.id === product.id)).toBe(
        true,
      );

      expect(await testApp.redis.client.exists(CATALOG_KEY)).toBe(1);
      expect(await testApp.redis.client.exists(CATALOG_LOCK)).toBe(0);

    } finally {

      replicaRedis.onModuleDestroy();

    }
  });

  it('recovers when a previous cache owner abandons its expiring lock', async () => {
    const testApp = context!;

    await testApp.redis.client.set(CATALOG_LOCK, 'abandoned', { PX: 200 });

    const response = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(response.body).toMatchObject([{ id: product.id }]);
    expect(await testApp.redis.client.exists(CATALOG_KEY)).toBe(1);
    expect(await testApp.redis.client.exists(CATALOG_LOCK)).toBe(0);
  });

  it('falls back to PostgreSQL when its disposable Redis container stops', async () => {
    const testApp = context!;

    await testApp.stopRedis();
    await waitUntil(async () => !testApp.redis.client.isReady, 'Redis outage');

    const response = await request(testApp.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(response.body).toMatchObject([{ id: product.id, netPrice: 2990 }]);

    const metrics = await request(testApp.app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(metrics.text).toContain(
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
