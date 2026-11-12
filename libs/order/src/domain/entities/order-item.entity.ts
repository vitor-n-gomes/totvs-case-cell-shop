import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('order_item')
export class OrderItemEntity {
  @PrimaryGeneratedColumn('uuid') 
  id: string;

  @Column('uuid', { name: 'order_id' }) 
  orderId: string;

  @Column('uuid', { name: 'product_id' })
  productId: string;

  @Column('integer') 
  quantity: number;

  @Column('int', { name: 'net_price' })
  netPrice: number;

  @Column('int', { name: 'list_price'})
  listPrice: number;
}
