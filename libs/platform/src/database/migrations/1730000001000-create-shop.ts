import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateShop1730000001000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE "order" (
        id uuid PRIMARY KEY, payment_type varchar(16) NOT NULL CHECK (payment_type IN ('PREPAID','POSTPAID')),
        due_date date NOT NULL, main_contact varchar(254) NOT NULL, alt_contact varchar(254),
        payment_method varchar(100) NOT NULL, environment varchar(16) NOT NULL CHECK (environment IN ('LOCAL','PRE_PROD','PROD')),
        status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','CANCELLED')),
        processing_status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (processing_status IN ('PENDING','PROCESSING','RETRYING','COMPLETED','FAILED')),
        idempotency_key varchar(128) NOT NULL UNIQUE, request_hash varchar(64) NOT NULL,
        last_attempt integer NOT NULL DEFAULT 0 CHECK (last_attempt BETWEEN 0 AND 5),
        correlation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE product (
        id uuid PRIMARY KEY, name varchar(200) NOT NULL, product_key varchar(100) NOT NULL UNIQUE,
        net_price numeric(12,2) NOT NULL CHECK (net_price >= 0), list_price numeric(12,2) NOT NULL CHECK (list_price >= 0)
      );
      CREATE TABLE order_item (
        id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES "order"(id), product_id uuid NOT NULL REFERENCES product(id),
        quantity integer NOT NULL CHECK (quantity > 0), net_price numeric(12,2) NOT NULL CHECK (net_price >= 0),
        list_price numeric(12,2) NOT NULL CHECK (list_price >= 0), UNIQUE(order_id, product_id)
      );
      CREATE TABLE stock (
        id uuid PRIMARY KEY, product_id uuid NOT NULL UNIQUE REFERENCES product(id),
        physical_quantity integer NOT NULL CHECK (physical_quantity >= 0),
        reserved_quantity integer NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0 AND reserved_quantity <= physical_quantity)
      );
      CREATE TABLE stock_reservation (
        id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES "order"(id), product_id uuid NOT NULL REFERENCES product(id),
        quantity integer NOT NULL CHECK (quantity > 0), status varchar(16) NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED')),
        expires_at timestamptz NOT NULL, UNIQUE(order_id, product_id)
      );
      CREATE INDEX stock_reservation_expiry_idx ON stock_reservation(expires_at, order_id) WHERE status = 'ACTIVE';
      CREATE TABLE idempotency_log (
        id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES "order"(id), action varchar(100) NOT NULL,
        reference jsonb NOT NULL DEFAULT '{}', step varchar(100) NOT NULL, success boolean NOT NULL,
        description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idempotency_log_success_idx ON idempotency_log(order_id, action, step) WHERE success;
      CREATE INDEX idempotency_log_order_idx ON idempotency_log(order_id, created_at);
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES "order"(id), topic varchar(249) NOT NULL,
        payload jsonb NOT NULL, status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSED')),
        available_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
        deduplication_key varchar(200) NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX outbox_pending_idx ON outbox_events(available_at, created_at) WHERE status = 'PENDING';
      CREATE INDEX outbox_order_idx ON outbox_events(order_id);
      CREATE TABLE request_log (
        id uuid PRIMARY KEY, url varchar(2048) NOT NULL, method varchar(16) NOT NULL, payload jsonb NOT NULL,
        correlation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX request_log_correlation_idx ON request_log(correlation_id);
    `);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TABLE request_log, outbox_events, idempotency_log, stock_reservation, stock, order_item, product, "order"',
    );
  }
}
