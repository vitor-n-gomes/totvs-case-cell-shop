import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStockReservation1794700000005 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE stock_reservation (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL,
        product_id uuid NOT NULL,
        quantity integer NOT NULL,
        status varchar(16) NOT NULL,
        expires_at timestamptz NOT NULL,
        CONSTRAINT pk_stock_reservation PRIMARY KEY (id),
        CONSTRAINT uq_stock_reservation_order_id_product_id UNIQUE (order_id, product_id),
        CONSTRAINT chk_stock_reservation_quantity CHECK (quantity > 0),
        CONSTRAINT chk_stock_reservation_status CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED'))
      );
      CREATE INDEX idx_stock_reservation_order_id ON stock_reservation (order_id);
      CREATE INDEX idx_stock_reservation_product_id ON stock_reservation (product_id);
      CREATE INDEX stock_reservation_expiry_idx ON stock_reservation (expires_at, order_id) WHERE status = 'ACTIVE';
      ALTER TABLE stock_reservation
        ADD CONSTRAINT fk_stock_reservation_order_id FOREIGN KEY (order_id)
        REFERENCES "order" (id) ON DELETE CASCADE ON UPDATE NO ACTION;
      ALTER TABLE stock_reservation
        ADD CONSTRAINT fk_stock_reservation_product_id FOREIGN KEY (product_id)
        REFERENCES product (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stock_reservation DROP CONSTRAINT fk_stock_reservation_product_id;
      ALTER TABLE stock_reservation DROP CONSTRAINT fk_stock_reservation_order_id;
      DROP INDEX stock_reservation_expiry_idx;
      DROP INDEX idx_stock_reservation_product_id;
      DROP INDEX idx_stock_reservation_order_id;
      DROP TABLE stock_reservation;
    `);
  }
}
