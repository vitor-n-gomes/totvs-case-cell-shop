import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRequestLog1794700000008 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE request_log (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        url varchar(2048) NOT NULL,
        method varchar(16) NOT NULL,
        payload jsonb NOT NULL,
        correlation_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_request_log PRIMARY KEY (id)
      );
      CREATE INDEX request_log_correlation_idx ON request_log (correlation_id);
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP INDEX request_log_correlation_idx;
      DROP TABLE request_log;
    `);
  }
}
