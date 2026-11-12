import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('product')
export class ProductEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('varchar') name!: string;
  @Column('varchar', { name: 'product_key' }) productKey!: string;
  @Column('numeric', { name: 'net_price', precision: 12, scale: 2 })
  netPrice!: string;
  @Column('numeric', { name: 'list_price', precision: 12, scale: 2 })
  listPrice!: string;
}
@Entity('stock')
export class StockEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'product_id' }) productId!: string;
  @Column('integer', { name: 'physical_quantity' }) physicalQuantity!: number;
  @Column('integer', { name: 'reserved_quantity' }) reservedQuantity!: number;
}
@Entity('stock_reservation')
export class ReservationEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'order_id' }) orderId!: string;
  @Column('uuid', { name: 'product_id' }) productId!: string;
  @Column('integer') quantity!: number;
  @Column('varchar') status!: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  @Column('timestamptz', { name: 'expires_at' }) expiresAt!: Date;
}

export const shopEntities = [ProductEntity, StockEntity, ReservationEntity];
