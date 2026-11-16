import { MigrationInterface, QueryRunner } from 'typeorm';

// Entities and the API treat prices as integer cents; the seed already stores cents.
export class ConvertPricesToIntegerCents1794700000011 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE product
        ALTER COLUMN net_price TYPE integer USING round(net_price)::integer,
        ALTER COLUMN list_price TYPE integer USING round(list_price)::integer;
      ALTER TABLE order_item
        ALTER COLUMN net_price TYPE integer USING round(net_price)::integer,
        ALTER COLUMN list_price TYPE integer USING round(list_price)::integer;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE product
        ALTER COLUMN net_price TYPE numeric(12,2),
        ALTER COLUMN list_price TYPE numeric(12,2);
      ALTER TABLE order_item
        ALTER COLUMN net_price TYPE numeric(12,2),
        ALTER COLUMN list_price TYPE numeric(12,2);
    `);
  }
}
