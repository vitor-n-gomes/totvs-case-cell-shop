import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { createClient } from 'redis';
import { validateEnvironment } from '@app/platform/config/environment';
import { databaseOptions } from '@app/platform/database/options';
import { CATALOG_KEY, CATALOG_LOCK } from '@app/shop/catalog/get-products';

async function seed(): Promise<void> {
  config({ path: process.env.ENV_FILE ?? ['.env.local', '.env'] });
  const environment = validateEnvironment(process.env);
  const database = new DataSource(databaseOptions(environment.DATABASE_URL));
  const redis = createClient({
    url: environment.REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: 1000 },
  });
  redis.on('error', () => undefined);
  try {
    // Require invalidation availability before changing catalog data.
    await redis.connect();
    await database.initialize();
    await database.transaction(async (manager) => {
      for (const [id, name, key, net, list] of [
        [
          '11111111-1111-4111-8111-111111111111',
          'Clear phone case',
          'clear-case',
          '29.90',
          '39.90',
        ],
        [
          '22222222-2222-4222-8222-222222222222',
          'Silicone phone case',
          'silicone-case',
          '39.90',
          '49.90',
        ],
        [
          '33333333-3333-4333-8333-333333333333',
          'Rugged phone case',
          'rugged-case',
          '59.90',
          '79.90',
        ],
      ]) {
        await manager.query(
          'INSERT INTO product (id,name,product_key,net_price,list_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name=excluded.name,product_key=excluded.product_key,net_price=excluded.net_price,list_price=excluded.list_price',
          [id, name, key, net, list],
        );
        // Re-running a seed must never replenish sold or reserved stock.
        await manager.query(
          'INSERT INTO stock (id,product_id,physical_quantity) VALUES ($1,$2,100) ON CONFLICT (product_id) DO NOTHING',
          [randomUUID(), id],
        );
      }
    });
    await redis
      .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
      .del([CATALOG_KEY, CATALOG_LOCK]);
    process.stdout.write(
      'Catalog seeded; existing stock preserved and cache invalidated.\n',
    );
  } finally {
    if (redis.isOpen) redis.destroy();
    if (database.isInitialized) await database.destroy();
  }
}
void seed().catch(() => {
  process.stderr.write(
    'Seed failed. If the transaction committed, retry seed to invalidate the cache.\n',
  );
  process.exitCode = 1;
});
