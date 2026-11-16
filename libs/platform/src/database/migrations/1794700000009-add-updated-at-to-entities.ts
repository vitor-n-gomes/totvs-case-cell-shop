import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUpdatedAtToEntities1794700000009 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order"
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE product
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE stock
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE order_item
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE stock_reservation
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE idempotency_log
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE outbox_events
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE request_log
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order" DROP COLUMN IF EXISTS updated_at;
      ALTER TABLE product DROP COLUMN IF EXISTS updated_at;
      ALTER TABLE stock DROP COLUMN IF EXISTS updated_at;
      ALTER TABLE order_item DROP COLUMN IF EXISTS updated_at;
      ALTER TABLE stock_reservation DROP COLUMN IF EXISTS updated_at;
      ALTER TABLE idempotency_log DROP COLUMN IF EXISTS updated_at;
      ALTER TABLE outbox_events DROP COLUMN IF EXISTS updated_at;
      ALTER TABLE request_log DROP COLUMN IF EXISTS updated_at;
    `);
  }
}
