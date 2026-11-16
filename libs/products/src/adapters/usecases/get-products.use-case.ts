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

const productSchema = z.array(
  z.strictObject({
    id: z.uuid(),
    name: z.string(),
    productKey: z.string(),
    netPrice: z.number(),
    listPrice: z.number(),
  }),
);

type ProductView = z.infer<typeof productSchema>[number];
@Injectable()
export class GetProductsUseCase {
  private flight?: Promise<ProductView[]>;
  constructor(
    private readonly products: ProductRepository,
    private readonly redis: RedisConnection,
    private readonly metrics: Metrics,
    private readonly spans: Spans,
    private readonly logger: AppLogger,
  ) {}

  execute(): Promise<ProductView[]> {
    return this.spans.run('catalog.get', async () => {
      try {
        const cached = await this.read();

        if (cached) {
          this.metrics.cache.inc({ result: 'hit' });

          return cached;
        }

        this.metrics.cache.inc({ result: 'miss' });
      } catch {
        this.metrics.cache.inc({ result: 'unavailable' });

        return this.singleFlight(() => this.load());
      }

      return this.singleFlight(() => this.fill());
    });
  }

  private singleFlight(
    operation: () => Promise<ProductView[]>,
  ): Promise<ProductView[]> {
    if (!this.flight) {
      this.flight = operation().finally(() => {
        this.flight = undefined;
      });
    }

    return this.flight;
  }

  private client() {
    if (!this.redis.client.isReady) {
      throw new Error('Cache unavailable');
    }

    return this.redis.client.withCommandOptions({
      abortSignal: AbortSignal.timeout(1000),
    });
  }

  private async read(): Promise<ProductView[] | null> {
    const value = await this.client().get(CATALOG_KEY);

    if (!value) {
      return null;
    }

    try {
      return productSchema.parse(JSON.parse(value));
    } catch {
      this.metrics.cache.inc({ result: 'invalid' });

      return null;
    }
  }

  private load(): Promise<ProductView[]> {
    return this.spans.run('catalog.repository', async () => {
      try {
        const rows = await this.products.findAll();

        return rows.map((product) => ({
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
    const deadline = Date.now() + 6000;

    while (Date.now() < deadline) {
      const token = randomUUID();
      let locked: string | null;

      try {
        const cached = await this.read();

        if (cached) {
          return cached;
        }

        locked = await this.client().set(CATALOG_LOCK, token, {
          NX: true,
          PX: 5000,
        });
      } catch {
        this.logger.warn('catalog.cache.unavailable');

        return this.load();
      }

      if (locked) {
        try {
          const products = await this.load();

          // An expired/replaced lock must never publish a stale loader's result.
          try {
            const stored = await this.client().eval(
              "if redis.call('get',KEYS[1]) == ARGV[1] then redis.call('set',KEYS[2],ARGV[2],'EX',300); return 1 end; return 0",
              {
                keys: [CATALOG_LOCK, CATALOG_KEY],
                arguments: [token, JSON.stringify(products)],
              },
            );

            if (stored !== 1) {
              continue;
            }
          } catch {
            this.logger.warn('catalog.cache.write.failed');
          }

          return products;
        } finally {
          try {
            await this.client().eval(
              "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end; return 0",
              { keys: [CATALOG_LOCK], arguments: [token] },
            );
          } catch {
            this.logger.warn('catalog.cache.unlock.failed');
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
