import { MigrationInterface, QueryRunner } from 'typeorm';

// Keep historical values independent of the application's enum declarations.
const columns: {
  name: string;
  values: [string, string][];
  defaultValue?: [string, string];
}[] = [
  {
    name: 'payment_type',
    values: [
      ['PREPAID', 'PrePaid'],
      ['POSTPAID', 'PostPaid'],
    ],
  },
  {
    name: 'environment',
    values: [
      ['LOCAL', 'Local'],
      ['PRE_PROD', 'PreProd'],
      ['PROD', 'Prod'],
    ],
  },
  {
    name: 'status',
    values: [
      ['PENDING', 'Pending'],
      ['ACTIVE', 'Active'],
      ['CANCELLED', 'Cancelled'],
    ],
    defaultValue: ['PENDING', 'Pending'],
  },
  {
    name: 'processing_status',
    values: [
      ['PENDING', 'Pending'],
      ['PROCESSING', 'Processing'],
      ['RETRYING', 'Retrying'],
      ['COMPLETED', 'Completed'],
      ['FAILED', 'Failed'],
    ],
    defaultValue: ['PENDING', 'Pending'],
  },
];

export class UseOrderEnums1794441600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    for (const column of columns) {
      await runner.query(`
        ALTER TABLE "order"
          DROP CONSTRAINT "order_${column.name}_check",
          ALTER COLUMN "${column.name}" DROP DEFAULT;
        UPDATE "order" SET "${column.name}" =
          CASE "${column.name}" ${column.values.map(([old, value]) => `WHEN '${old}' THEN '${value}'`).join(' ')} ELSE "${column.name}" END;
      `);
      if (column.defaultValue) {
        await runner.query(
          `ALTER TABLE "order" ALTER COLUMN "${column.name}" SET DEFAULT '${column.defaultValue[1]}'`,
        );
      }
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const column of columns.toReversed()) {
      await runner.query(`
        ALTER TABLE "order" ALTER COLUMN "${column.name}" DROP DEFAULT;
        UPDATE "order" SET "${column.name}" =
          CASE "${column.name}" ${column.values.map(([old, value]) => `WHEN '${value}' THEN '${old}'`).join(' ')} ELSE "${column.name}" END;
        ALTER TABLE "order" ADD CONSTRAINT "order_${column.name}_check"
          CHECK ("${column.name}" IN (${column.values.map(([old]) => `'${old}'`).join(', ')}));
      `);
      if (column.defaultValue) {
        await runner.query(
          `ALTER TABLE "order" ALTER COLUMN "${column.name}" SET DEFAULT '${column.defaultValue[0]}'`,
        );
      }
    }
  }
}
