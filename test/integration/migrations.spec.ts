import 'reflect-metadata';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { databaseOptions } from '@app/platform/database/options';
import { validateEnvironment } from '@app/platform/config/environment';

it('runs, reverses and reapplies both migrations in an isolated PostgreSQL schema', async () => {
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
    expect(await isolated.runMigrations()).toHaveLength(2);
    await isolated.undoLastMigration();
    await isolated.undoLastMigration();
    const remaining: { table_name: string }[] = await control.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=$1',
      [schema],
    );
    expect(remaining.map((entry) => entry.table_name)).toEqual(['migrations']);
    expect(await isolated.runMigrations()).toHaveLength(2);
  } finally {
    if (isolated?.isInitialized) await isolated.destroy();
    await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.destroy();
  }
});
