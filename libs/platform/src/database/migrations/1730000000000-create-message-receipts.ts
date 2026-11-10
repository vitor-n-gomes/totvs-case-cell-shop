import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessageReceipts1730000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE demo_message_receipts (
      event_id uuid PRIMARY KEY,
      schema_version smallint NOT NULL CHECK (schema_version = 1),
      correlation_id uuid NOT NULL,
      message varchar(500) NOT NULL CHECK (message ~ '[^[:space:]]'),
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE demo_message_receipts');
  }
}
