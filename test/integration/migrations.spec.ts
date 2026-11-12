import 'reflect-metadata';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  PaymentType,
  Environment,
  OrderStatus,
  ProcessingStatus,
} from '@app/contracts';
import { databaseOptions } from '@app/platform/database/options';
import { validateEnvironment } from '@app/platform/config/environment';

it('keeps enum fields as strings, upgrades existing orders, rolls back and reapplies without data loss', async () => {
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
    const insert = async (
      paymentType: string,
      environment: string,
      status?: string,
      processingStatus?: string,
    ) => {
      const id = randomUUID();
      await isolated!.query(
        `
        INSERT INTO "order" (id, payment_type, environment, due_date, main_contact, payment_method,
          idempotency_key, request_hash, correlation_id${status ? ', status, processing_status' : ''})
        VALUES ($1::uuid, $2, $3, '2026-11-10', 'migration@example.test', 'PIX', $1::text, 'hash', $1::uuid${status ? ', $4, $5' : ''})
      `,
        status
          ? [id, paymentType, environment, status, processingStatus]
          : [id, paymentType, environment],
      );
      return id;
    };
    const read = (id: string) =>
      isolated!.query(
        'SELECT payment_type, environment, status, processing_status FROM "order" WHERE id=$1',
        [id],
      );
    const enumColumns = {
      payment_type: Object.values(PaymentType),
      environment: Object.values(Environment),
      status: Object.values(OrderStatus),
      processing_status: Object.values(ProcessingStatus),
    };
    const verifyStringColumns = async () => {
      const runner = isolated!.createQueryRunner();
      try {
        const table = await runner.getTable(`${schema}.order`);
        for (const name of Object.keys(enumColumns)) {
          expect(table!.findColumnByName(name)).toMatchObject({
            type: 'character varying',
            length: '16',
          });
        }
        expect(
          await isolated!.query(
            `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typtype='e'`,
            [schema],
          ),
        ).toEqual([]);
      } finally {
        await runner.release();
      }
    };

    // Fresh installation keeps string columns with PascalCase pending defaults.
    expect(await isolated.runMigrations()).toHaveLength(2);
    await verifyStringColumns();
    const defaultId = await insert(PaymentType.PrePaid, Environment.Local);
    expect(await read(defaultId)).toEqual([
      {
        payment_type: PaymentType.PrePaid,
        environment: Environment.Local,
        status: OrderStatus.Pending,
        processing_status: ProcessingStatus.Pending,
      },
    ]);
    // Enum validation belongs to the application; storage accepts normal strings.
    const [defaults]: Record<string, string>[] = await read(defaultId);
    for (const column of Object.keys(enumColumns)) {
      await isolated.query(
        `UPDATE "order" SET "${column}"='CustomValue' WHERE id=$1`,
        [defaultId],
      );
      expect((await read(defaultId))[0][column]).toBe('CustomValue');
      await isolated.query(`UPDATE "order" SET "${column}"=$1 WHERE id=$2`, [
        defaults![column],
        defaultId,
      ]);
    }

    // Restore the original schema, populate every legacy value, then upgrade.
    await isolated.undoLastMigration();
    expect(await read(defaultId)).toEqual([
      {
        payment_type: 'PREPAID',
        environment: 'LOCAL',
        status: 'PENDING',
        processing_status: 'PENDING',
      },
    ]);
    const cases = [
      ['PREPAID', 'LOCAL', 'PENDING', 'PENDING'],
      ['POSTPAID', 'PRE_PROD', 'ACTIVE', 'PROCESSING'],
      ['PREPAID', 'PROD', 'CANCELLED', 'RETRYING'],
      ['POSTPAID', 'LOCAL', 'ACTIVE', 'COMPLETED'],
      ['PREPAID', 'PRE_PROD', 'CANCELLED', 'FAILED'],
    ];
    const expected = [
      [
        PaymentType.PrePaid,
        Environment.Local,
        OrderStatus.Pending,
        ProcessingStatus.Pending,
      ],
      [
        PaymentType.PostPaid,
        Environment.PreProd,
        OrderStatus.Active,
        ProcessingStatus.Processing,
      ],
      [
        PaymentType.PrePaid,
        Environment.Prod,
        OrderStatus.Cancelled,
        ProcessingStatus.Retrying,
      ],
      [
        PaymentType.PostPaid,
        Environment.Local,
        OrderStatus.Active,
        ProcessingStatus.Completed,
      ],
      [
        PaymentType.PrePaid,
        Environment.PreProd,
        OrderStatus.Cancelled,
        ProcessingStatus.Failed,
      ],
    ];
    const ids: string[] = [];
    for (const values of cases)
      ids.push(await insert(values[0]!, values[1]!, values[2]!, values[3]!));
    const legacyDefaultId = await insert('POSTPAID', 'PROD');
    expect((await read(legacyDefaultId))[0]).toMatchObject({
      status: 'PENDING',
      processing_status: 'PENDING',
    });
    expect(await isolated.runMigrations()).toHaveLength(1);
    await verifyStringColumns();
    for (const [index, id] of ids.entries()) {
      expect(await read(id)).toEqual([
        Object.fromEntries(
          Object.keys(enumColumns).map((column, i) => [
            column,
            expected[index]![i],
          ]),
        ),
      ]);
    }
    expect((await read(legacyDefaultId))[0]).toMatchObject({
      status: OrderStatus.Pending,
      processing_status: ProcessingStatus.Pending,
    });

    await isolated.undoLastMigration();
    for (const [index, id] of ids.entries()) {
      expect(await read(id)).toEqual([
        Object.fromEntries(
          Object.keys(enumColumns).map((column, i) => [
            column,
            cases[index]![i],
          ]),
        ),
      ]);
    }
    await expect(
      isolated.query('UPDATE "order" SET payment_type=$1 WHERE id=$2', [
        PaymentType.PrePaid,
        defaultId,
      ]),
    ).rejects.toThrow();
    expect(await isolated.runMigrations()).toHaveLength(1);
    await verifyStringColumns();
    await isolated.undoLastMigration();
    await isolated.undoLastMigration();
    const remaining: { table_name: string }[] = await control.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=$1',
      [schema],
    );
    expect(remaining.map((entry) => entry.table_name)).toEqual(['migrations']);
    expect(
      await control.query(
        `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typtype='e'`,
        [schema],
      ),
    ).toEqual([]);
    expect(await isolated.runMigrations()).toHaveLength(2);
    await verifyStringColumns();
  } finally {
    if (isolated?.isInitialized) await isolated.destroy();
    await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.destroy();
  }
});
