import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProduct1794700000002 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE product (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        name varchar(200) NOT NULL,
        product_key varchar(100) NOT NULL,
        net_price numeric(12,2) NOT NULL,
        list_price numeric(12,2) NOT NULL,
        CONSTRAINT pk_product PRIMARY KEY (id),
        CONSTRAINT uq_product_product_key UNIQUE (product_key),
        CONSTRAINT chk_product_net_price CHECK (net_price >= 0),
        CONSTRAINT chk_product_list_price CHECK (list_price >= 0)
      )
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE product');
  }
}
