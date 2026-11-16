import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdempotencyLog1794700000006 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idempotency_log (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL,
        action varchar(100) NOT NULL,
        reference jsonb NOT NULL DEFAULT '{}',
        step varchar(100) NOT NULL,
        success boolean NOT NULL,
        description text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_idempotency_log PRIMARY KEY (id)
      );
      CREATE INDEX idx_idempotency_log_order_id ON idempotency_log (order_id, created_at);
      CREATE UNIQUE INDEX idempotency_log_success_idx ON idempotency_log (order_id, action, step) WHERE success;
      ALTER TABLE idempotency_log
        ADD CONSTRAINT fk_idempotency_log_order_id FOREIGN KEY (order_id)
        REFERENCES "order" (id) ON DELETE CASCADE ON UPDATE NO ACTION;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE idempotency_log DROP CONSTRAINT fk_idempotency_log_order_id;
      DROP INDEX idempotency_log_success_idx;
      DROP INDEX idx_idempotency_log_order_id;
      DROP TABLE idempotency_log;
    `);
  }
}
