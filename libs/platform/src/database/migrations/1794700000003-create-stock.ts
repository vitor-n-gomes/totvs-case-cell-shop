import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStock1794700000003 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE stock (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        product_id uuid NOT NULL,
        physical_quantity integer NOT NULL,
        reserved_quantity integer NOT NULL DEFAULT 0,
        CONSTRAINT pk_stock PRIMARY KEY (id),
        CONSTRAINT chk_stock_physical_quantity CHECK (physical_quantity >= 0),
        CONSTRAINT chk_stock_reserved_quantity CHECK (reserved_quantity >= 0 AND reserved_quantity <= physical_quantity)
      );
      CREATE UNIQUE INDEX idx_stock_product_id ON stock (product_id);
      ALTER TABLE stock
        ADD CONSTRAINT fk_stock_product_id FOREIGN KEY (product_id)
        REFERENCES product (id) ON DELETE CASCADE ON UPDATE NO ACTION;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE stock DROP CONSTRAINT fk_stock_product_id;
      DROP INDEX idx_stock_product_id;
      DROP TABLE stock;
    `);
  }
}
