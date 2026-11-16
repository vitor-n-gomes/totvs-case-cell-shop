import { MigrationInterface, QueryRunner } from 'typeorm';

// Entities and the API treat prices as integer cents; the seed already stores cents.
export class ConvertPricesToIntegerCents1794700000011 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE product
        ALTER COLUMN net_price TYPE integer USING round(net_price)::integer,
        ALTER COLUMN list_price TYPE integer USING round(list_price)::integer;
      ALTER TABLE order_item
        ALTER COLUMN net_price TYPE integer USING round(net_price)::integer,
        ALTER COLUMN list_price TYPE integer USING round(list_price)::integer;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE product
        ALTER COLUMN net_price TYPE numeric(12,2),
        ALTER COLUMN list_price TYPE numeric(12,2);
      ALTER TABLE order_item
        ALTER COLUMN net_price TYPE numeric(12,2),
        ALTER COLUMN list_price TYPE numeric(12,2);
    `);
  }
}
