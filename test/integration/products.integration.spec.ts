import request from 'supertest';
import { CATALOG_KEY } from '@app/products/adapters/usecases/get-products.use-case';
import { newProduct } from './support/in-memory-store';
import { createTestApp, TestApp } from './support/test-app';

async function cacheCount(
  { metricsService }: TestApp,
  result: 'hit' | 'miss',
): Promise<number> {
  const { values } = await metricsService.cacheRequestsCounter.get();

  return values.find((value) => value.labels.result === result)?.value ?? 0;
}

describe('GET /products (integration)', () => {
  let testContext: TestApp;

  const products = [
    newProduct({ productKey: 'a-clear-case', netPrice: 2990, listPrice: 3990 }),
    newProduct({
      productKey: 'b-rugged-case',
      netPrice: 5990,
      listPrice: 7990,
    }),
  ];

  beforeEach(async () => {
    testContext = await createTestApp();
    testContext.inMemoryStore.seedProducts(products);
  });

  afterEach(async () => {
    await testContext.app.close();
  });

  it('returns the catalog from the database on a cache miss and caches it', async () => {
    const response = await request(testContext.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(response.body).toEqual(
      products.map(({ id, name, productKey, netPrice, listPrice }) => ({
        id,
        name,
        productKey,
        netPrice,
        listPrice,
      })),
    );

    expect(testContext.inMemoryStore.catalogQueries).toBe(1);
    expect(testContext.redisConnection.redisClient.has(CATALOG_KEY)).toBe(true);

    expect(
      testContext.redisConnection.redisClient.ttlSeconds(CATALOG_KEY),
    ).toBeGreaterThan(290);

    expect(
      testContext.redisConnection.redisClient.ttlSeconds(CATALOG_KEY),
    ).toBeLessThanOrEqual(300);

    expect(await cacheCount(testContext, 'miss')).toBe(1);
  });

  it('serves the same catalog from the cache on the second consecutive call', async () => {
    const first = await request(testContext.app.getHttpServer())
      .get('/products')
      .expect(200);

    const second = await request(testContext.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(second.body).toEqual(first.body);
    expect(testContext.inMemoryStore.catalogQueries).toBe(1);
    expect(await cacheCount(testContext, 'miss')).toBe(1);
    expect(await cacheCount(testContext, 'hit')).toBe(1);
  });
});
