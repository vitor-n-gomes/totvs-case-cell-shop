import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutboxEvents1794700000007 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE outbox_events (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL,
        topic varchar(249) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        available_at timestamptz NOT NULL DEFAULT now(),
        lease_token uuid,
        lease_until timestamptz,
        deduplication_key varchar(200) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_outbox_events PRIMARY KEY (id),
        CONSTRAINT uq_outbox_events_deduplication_key UNIQUE (deduplication_key),
        CONSTRAINT chk_outbox_events_status CHECK (status IN ('PENDING','PROCESSED'))
      );
      CREATE INDEX idx_outbox_events_order_id ON outbox_events (order_id);
      CREATE INDEX outbox_pending_idx ON outbox_events (available_at, created_at) WHERE status = 'PENDING';
      ALTER TABLE outbox_events
        ADD CONSTRAINT fk_outbox_events_order_id FOREIGN KEY (order_id)
        REFERENCES "order" (id) ON DELETE CASCADE ON UPDATE NO ACTION;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE outbox_events DROP CONSTRAINT fk_outbox_events_order_id;
      DROP INDEX outbox_pending_idx;
      DROP INDEX idx_outbox_events_order_id;
      DROP TABLE outbox_events;
    `);
  }
}
