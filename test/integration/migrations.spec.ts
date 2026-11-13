import 'reflect-metadata';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { databaseOptions } from '@app/platform/database/options';
import { validateEnvironment } from '@app/platform/config/environment';

const foreignKeys = [
  ['stock', 'product_id', 'product', 'CASCADE'],
  ['order_item', 'order_id', 'order', 'CASCADE'],
  ['order_item', 'product_id', 'product', 'RESTRICT'],
  ['stock_reservation', 'order_id', 'order', 'CASCADE'],
  ['stock_reservation', 'product_id', 'product', 'RESTRICT'],
  ['idempotency_log', 'order_id', 'order', 'CASCADE'],
  ['outbox_events', 'order_id', 'order', 'CASCADE'],
];

it('creates parent tables first with indexed foreign keys, rolls back and reapplies', async () => {
  config({ path: process.env.TEST_ENV_FILE ?? '.env.test.local' });
  const env = validateEnvironment(process.env),
    url = new URL(env.DATABASE_URL);
  if (
    env.NODE_ENV !== 'test' ||
    !url.pathname.endsWith('_test') ||
    !['localhost', '127.0.0.1', 'postgres'].includes(url.hostname)
  )
    throw new Error('Dedicated local test database required');
  const schema = `migration_${randomUUID().replaceAll('-', '')}`;
  const control = new DataSource(databaseOptions(env.DATABASE_URL));
  await control.initialize();
  let isolated: DataSource | undefined;
  try {
    await control.query(`CREATE SCHEMA "${schema}"`);
    const options = databaseOptions(env.DATABASE_URL);
    if (options.type !== 'postgres') throw new Error('PostgreSQL expected');
    isolated = new DataSource({
      ...options,
      schema,
      extra: {
        ...(options.extra as object),
        options: `-c search_path=${schema}`,
      },
    });
    await isolated.initialize();
    const constraints = () =>
      control.query<
        {
          child: string;
          column: string;
          parent: string;
          on_delete: string;
          indexed: boolean;
        }[]
      >(
        `SELECT c.conrelid::regclass::text AS child, a.attname AS "column",
           c.confrelid::regclass::text AS parent,
           CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' ELSE c.confdeltype::text END AS on_delete,
           EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = a.attnum) AS indexed
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND c.connamespace = $1::regnamespace`,
        [schema],
      );
    const unqualified = (name: string) =>
      name.split('.').at(-1)!.replaceAll('"', '');

    expect(await isolated.runMigrations()).toHaveLength(8);
    const actual = (await constraints()).map((fk) => [
      unqualified(fk.child),
      fk.column,
      unqualified(fk.parent),
      fk.on_delete,
    ]);
    expect(actual).toEqual(expect.arrayContaining(foreignKeys));
    expect(actual).toHaveLength(foreignKeys.length);
    expect((await constraints()).every((fk) => fk.indexed)).toBe(true);

    const orderId = randomUUID(),
      productId = randomUUID();
    await isolated.query(
      `INSERT INTO "order" (payment_type, due_date, main_contact, payment_method, environment, idempotency_key, request_hash, correlation_id, id)
       VALUES ('PrePaid', '2026-11-10', 'a@example.test', 'PIX', 'Local', 'k', 'h', $1, $1)`,
      [orderId],
    );
    await isolated.query(
      `INSERT INTO product (id, name, product_key, net_price, list_price) VALUES ($1, 'P', 'p', 10, 12)`,
      [productId],
    );
    await expect(
      isolated.query(
        `INSERT INTO order_item (order_id, product_id, quantity, net_price, list_price) VALUES ($1, $2, 1, 10, 12)`,
        [randomUUID(), productId],
      ),
    ).rejects.toThrow(/foreign key/);
    await isolated.query(
      `INSERT INTO order_item (order_id, product_id, quantity, net_price, list_price) VALUES ($1, $2, 1, 10, 12)`,
      [orderId, productId],
    );
    await expect(
      isolated.query('DELETE FROM product WHERE id = $1', [productId]),
    ).rejects.toThrow(/foreign key/);
    await isolated.query('DELETE FROM "order" WHERE id = $1', [orderId]);
    expect(await isolated.query('SELECT 1 FROM order_item')).toEqual([]);

    for (let index = 0; index < 8; index++) await isolated.undoLastMigration();
    const remaining: { table_name: string }[] = await control.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=$1',
      [schema],
    );
    expect(remaining.map((entry) => entry.table_name)).toEqual(['migrations']);
    expect(await isolated.runMigrations()).toHaveLength(8);
  } finally {
    if (isolated?.isInitialized) await isolated.destroy();
    await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.destroy();
  }
});
