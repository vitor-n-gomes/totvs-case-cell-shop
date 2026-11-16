import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCreatedAtToEntities1794700000010 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE product
        ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE stock
        ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE order_item
        ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE stock_reservation
        ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE product DROP COLUMN IF EXISTS created_at;
      ALTER TABLE stock DROP COLUMN IF EXISTS created_at;
      ALTER TABLE order_item DROP COLUMN IF EXISTS created_at;
      ALTER TABLE stock_reservation DROP COLUMN IF EXISTS created_at;
    `);
  }
}
