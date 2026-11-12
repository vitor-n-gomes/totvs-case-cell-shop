import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('order_item')
export class OrderItemEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'order_id' }) orderId!: string;
  @Column('uuid', { name: 'product_id' }) productId!: string;
  @Column('integer') quantity!: number;
  @Column('numeric', { name: 'net_price', precision: 12, scale: 2 })
  netPrice!: string;
  @Column('numeric', { name: 'list_price', precision: 12, scale: 2 })
  listPrice!: string;
}
