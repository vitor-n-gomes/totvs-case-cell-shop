import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { faker } from '@faker-js/faker';
import { config } from 'dotenv';
import { DataSource, EntityManager } from 'typeorm';
import { createClient } from 'redis';
import { validateEnvironment } from '@app/platform/config/environment';
import { databaseOptions } from '@app/platform/database/options';
import {
  CATALOG_KEY,
  CATALOG_LOCK,
} from '@app/products/adapters/usecases/get-products.use-case';

interface SeedProduct {
  id: string;
  name: string;
  productKey: string;
  netPrice: number;
  listPrice: number;
}

const LIMITED_PRODUCT_KEY = 'CASE-LIMITED-001';

// Keep catalog names reproducible across runs with the pinned Faker version.
faker.seed(42);

function createProductName(style: string): string {
  const phoneModel = faker.helpers.arrayElement([
    'iPhone 16',
    'Samsung Galaxy S25',
    'Google Pixel 9',
  ]);

  const caseColor = faker.helpers.arrayElement([
    'Black',
    'Blue',
    'Pink',
    'Clear',
  ]);

  return `${style} phone case for ${phoneModel} - ${caseColor}`;
}

// Prices are integer cents.
const catalog: SeedProduct[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: createProductName('Clear'),
    productKey: 'clear-case',
    netPrice: 2990,
    listPrice: 3990,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: createProductName('Silicone'),
    productKey: 'silicone-case',
    netPrice: 3990,
    listPrice: 4990,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: createProductName('Rugged'),
    productKey: 'rugged-case',
    netPrice: 5990,
    listPrice: 7990,
  },
];

const limitedProduct: SeedProduct = {
  id: '44444444-4444-4444-8444-444444444444',
  name: createProductName('Limited Edition Titanium MagSafe'),
  productKey: LIMITED_PRODUCT_KEY,
  netPrice: 14990,
  listPrice: 19990,
};

// Conflicts on the unique product_key, so an existing row keeps its id.
async function upsertProduct(
  entityManager: EntityManager,
  product: SeedProduct,
): Promise<string> {
  const insertedProductRows: { id: string }[] = await entityManager.query(
    `INSERT INTO product (id,name,product_key,net_price,list_price)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (product_key) DO UPDATE SET
       name=excluded.name,
       net_price=excluded.net_price,
       list_price=excluded.list_price,
       updated_at=now()
     RETURNING id`,
    [
      product.id,
      product.name,
      product.productKey,
      product.netPrice,
      product.listPrice,
    ],
  );

  return insertedProductRows[0]!.id;
}

async function seed(): Promise<void> {
  const projectRoot = resolve(__dirname, '../../..');

  config({
    path:
      process.env.ENV_FILE ??
      ['.env.local', '.env'].map((environmentFile) =>
        resolve(projectRoot, environmentFile),
      ),
  });

  const environment = validateEnvironment(process.env);
  const dataSource = new DataSource(databaseOptions(environment.DATABASE_URL));

  const redisClient = createClient({
    url: environment.REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: 1000 },
  });

  redisClient.on('error', () => undefined);

  try {

    // Require invalidation availability before changing catalog data.
    await redisClient.connect();
    await dataSource.initialize();

    await dataSource.transaction(async (entityManager) => {
      for (const product of catalog) {

        const productId = await upsertProduct(entityManager, product);

        // Re-running a seed must never replenish sold or reserved stock.
        await entityManager.query(
          'INSERT INTO stock (id,product_id,physical_quantity) VALUES ($1,$2,100) ON CONFLICT (product_id) DO NOTHING',
          [randomUUID(), productId],
        );

      }

      // The restricted-inventory product is reset on every run so the
      // concurrency test always starts from one unit and no reservations.
      const limitedProductId = await upsertProduct(
        entityManager,
        limitedProduct,
      );

      await entityManager.query(
        'DELETE FROM stock_reservation WHERE product_id = $1',
        [limitedProductId],
      );

      await entityManager.query(
        `INSERT INTO stock (id,product_id,physical_quantity,reserved_quantity)
         VALUES ($1,$2,1,0)
         ON CONFLICT (product_id) DO UPDATE SET
           physical_quantity=1,
           reserved_quantity=0,
           updated_at=now()`,
        [randomUUID(), limitedProductId],
      );
    });

    await redisClient
      .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
      .del([CATALOG_KEY, CATALOG_LOCK]);

    process.stdout.write(
      `Catalog seeded; stock preserved except ${LIMITED_PRODUCT_KEY} (reset to 1 unit); cache invalidated.\n`,
    );

  } finally {

    if (redisClient.isOpen) {

      redisClient.destroy();

    }

    if (dataSource.isInitialized) {

      await dataSource.destroy();

    }

  }
}

void seed().catch((error: unknown) => {
  process.stderr.write(
    `Seed failed: ${error instanceof Error ? error.message : String(error)}\nIf the transaction committed, retry seed to invalidate the cache.\n`,
  );

  process.exitCode = 1;
});
