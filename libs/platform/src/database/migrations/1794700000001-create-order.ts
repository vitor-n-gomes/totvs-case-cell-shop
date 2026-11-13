import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrder1794700000001 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE "order" (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        payment_type varchar(16) NOT NULL,
        due_date date NOT NULL,
        main_contact varchar(254) NOT NULL,
        alt_contact varchar(254),
        payment_method varchar(100) NOT NULL,
        environment varchar(16) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'Pending',
        processing_status varchar(16) NOT NULL DEFAULT 'Pending',
        idempotency_key varchar(128) NOT NULL,
        request_hash varchar(64) NOT NULL,
        last_attempt integer NOT NULL DEFAULT 0,
        correlation_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_order PRIMARY KEY (id),
        CONSTRAINT uq_order_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT chk_order_last_attempt CHECK (last_attempt BETWEEN 0 AND 5)
      )
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "order"');
  }
}
