import request from 'supertest';
import { CATALOG_KEY } from '@app/products/adapters/usecases/get-products.use-case';
import { newProduct } from './support/in-memory-store';
import { createTestApp, TestApp } from './support/test-app';

async function cacheCount(
  { metrics }: TestApp,
  result: 'hit' | 'miss',
): Promise<number> {
  const { values } = await metrics.cache.get();

  return values.find((value) => value.labels.result === result)?.value ?? 0;
}

describe('GET /products (integration)', () => {
  let context: TestApp;

  const products = [
    newProduct({ productKey: 'a-clear-case', netPrice: 2990, listPrice: 3990 }),
    newProduct({
      productKey: 'b-rugged-case',
      netPrice: 5990,
      listPrice: 7990,
    }),
  ];

  beforeEach(async () => {
    context = await createTestApp();
    context.store.seedProducts(products);
  });

  afterEach(async () => {
    await context.app.close();
  });

  it('returns the catalog from the database on a cache miss and caches it', async () => {
    const response = await request(context.app.getHttpServer())
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

    expect(context.store.catalogQueries).toBe(1);
    expect(context.redis.client.has(CATALOG_KEY)).toBe(true);
    expect(context.redis.client.ttlSeconds(CATALOG_KEY)).toBeGreaterThan(290);

    expect(context.redis.client.ttlSeconds(CATALOG_KEY)).toBeLessThanOrEqual(
      300,
    );

    expect(await cacheCount(context, 'miss')).toBe(1);
  });

  it('serves the same catalog from the cache on the second consecutive call', async () => {
    const first = await request(context.app.getHttpServer())
      .get('/products')
      .expect(200);

    const second = await request(context.app.getHttpServer())
      .get('/products')
      .expect(200);

    expect(second.body).toEqual(first.body);
    expect(context.store.catalogQueries).toBe(1);
    expect(await cacheCount(context, 'miss')).toBe(1);
    expect(await cacheCount(context, 'hit')).toBe(1);
  });
});
