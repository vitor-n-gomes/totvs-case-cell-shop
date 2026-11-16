import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ProductRepository } from '../../repositories/product.repository';

export const CATALOG_KEY = 'storefront:products';
export const CATALOG_LOCK = `${CATALOG_KEY}:lock`;

const catalogSchema = z.array(
  z.strictObject({
    id: z.uuid(),
    name: z.string(),
    productKey: z.string(),
    netPrice: z.number(),
    listPrice: z.number(),
  }),
);

type ProductView = z.infer<typeof catalogSchema>[number];
@Injectable()
export class GetProductsUseCase {
  private catalogLoadPromise?: Promise<ProductView[]>;
  constructor(
    private readonly productRepository: ProductRepository,
    private readonly redisConnection: RedisConnection,
    private readonly metricsService: Metrics,
    private readonly spansService: Spans,
    private readonly appLogger: AppLogger,
  ) {}

  execute(): Promise<ProductView[]> {
    return this.spansService.run('catalog.get', async () => {
      try {

        const cachedProducts = await this.read();

        if (cachedProducts) {

          this.metricsService.cacheRequestsCounter.inc({ result: 'hit' });

          return cachedProducts;

        }

        this.metricsService.cacheRequestsCounter.inc({ result: 'miss' });

      } catch {

        this.metricsService.cacheRequestsCounter.inc({ result: 'unavailable' });

        return this.singleFlight(() => this.load());

      }

      return this.singleFlight(() => this.fill());
    });
  }

  private singleFlight(
    loadCatalog: () => Promise<ProductView[]>,
  ): Promise<ProductView[]> {
    if (!this.catalogLoadPromise) {

      this.catalogLoadPromise = loadCatalog().finally(() => {
        this.catalogLoadPromise = undefined;
      });

    }

    return this.catalogLoadPromise;
  }

  private client() {
    if (!this.redisConnection.redisClient.isReady) {

      throw new Error('Cache unavailable');

    }

    return this.redisConnection.redisClient.withCommandOptions({
      abortSignal: AbortSignal.timeout(1000),
    });
  }

  private async read(): Promise<ProductView[] | null> {
    const cachedCatalogJson = await this.client().get(CATALOG_KEY);

    if (!cachedCatalogJson) {

      return null;

    }

    try {

      return catalogSchema.parse(JSON.parse(cachedCatalogJson));

    } catch {

      this.metricsService.cacheRequestsCounter.inc({ result: 'invalid' });

      return null;

    }
  }

  private load(): Promise<ProductView[]> {
    return this.spansService.run('catalog.repository', async () => {
      try {

        const products = await this.productRepository.findAll();

        return products.map((product) => ({
          id: product.id,
          name: product.name,
          productKey: product.productKey,
          netPrice: Number(product.netPrice),
          listPrice: Number(product.listPrice),
        }));

      } catch {

        throw new ServiceUnavailableException(
          'Catalog temporarily unavailable',
        );

      }
    });
  }

  private async fill(): Promise<ProductView[]> {
    const refreshDeadlineMs = Date.now() + 6000;

    while (Date.now() < refreshDeadlineMs) {

      const lockToken = randomUUID();
      let lockAcquisitionResult: string | null;

      try {

        const cachedProducts = await this.read();

        if (cachedProducts) {

          return cachedProducts;

        }

        lockAcquisitionResult = await this.client().set(
          CATALOG_LOCK,
          lockToken,
          {
            NX: true,
            PX: 5000,
          },
        );

      } catch {

        this.appLogger.warn('catalog.cache.unavailable');

        return this.load();

      }

      if (lockAcquisitionResult) {

        try {

          const products = await this.load();

          // An expired/replaced lock must never publish a stale loader's result.
          try {

            const cacheWriteResult = await this.client().eval(
              "if redis.call('get',KEYS[1]) == ARGV[1] then redis.call('set',KEYS[2],ARGV[2],'EX',300); return 1 end; return 0",
              {
                keys: [CATALOG_LOCK, CATALOG_KEY],
                arguments: [lockToken, JSON.stringify(products)],
              },
            );

            if (cacheWriteResult !== 1) {

              continue;

            }

          } catch {

            this.appLogger.warn('catalog.cache.write.failed');

          }

          return products;

        } finally {

          try {

            await this.client().eval(
              "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end; return 0",
              { keys: [CATALOG_LOCK], arguments: [lockToken] },
            );

          } catch {

            this.appLogger.warn('catalog.cache.unlock.failed');

          }

        }

      }

      await new Promise((resolve) => setTimeout(resolve, 50));

    }

    throw new ServiceUnavailableException(
      'Catalog refresh in progress; retry shortly',
    );
  }
}
