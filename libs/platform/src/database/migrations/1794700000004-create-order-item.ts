import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrderItem1794700000004 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE order_item (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL,
        product_id uuid NOT NULL,
        quantity integer NOT NULL,
        net_price numeric(12,2) NOT NULL,
        list_price numeric(12,2) NOT NULL,
        CONSTRAINT pk_order_item PRIMARY KEY (id),
        CONSTRAINT uq_order_item_order_id_product_id UNIQUE (order_id, product_id),
        CONSTRAINT chk_order_item_quantity CHECK (quantity > 0),
        CONSTRAINT chk_order_item_net_price CHECK (net_price >= 0),
        CONSTRAINT chk_order_item_list_price CHECK (list_price >= 0)
      );
      CREATE INDEX idx_order_item_order_id ON order_item (order_id);
      CREATE INDEX idx_order_item_product_id ON order_item (product_id);
      ALTER TABLE order_item
        ADD CONSTRAINT fk_order_item_order_id FOREIGN KEY (order_id)
        REFERENCES "order" (id) ON DELETE CASCADE ON UPDATE NO ACTION;
      ALTER TABLE order_item
        ADD CONSTRAINT fk_order_item_product_id FOREIGN KEY (product_id)
        REFERENCES product (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE order_item DROP CONSTRAINT fk_order_item_product_id;
      ALTER TABLE order_item DROP CONSTRAINT fk_order_item_order_id;
      DROP INDEX idx_order_item_product_id;
      DROP INDEX idx_order_item_order_id;
      DROP TABLE order_item;
    `);
  }
}
