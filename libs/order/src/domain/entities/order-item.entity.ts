import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { ProductEntity } from '@app/shop/entities';
import { OrderEntity } from './order.entity';

@Entity('order_item')
export class OrderItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_order_item_order_id')
  @Column('uuid', { name: 'order_id' })
  orderId: string;

  @ManyToOne(() => OrderEntity, (order) => order.items, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<OrderEntity>;

  @Index('idx_order_item_product_id')
  @Column('uuid', { name: 'product_id' })
  productId: string;

  @ManyToOne(() => ProductEntity, (product) => product.orderItems, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<ProductEntity>;

  @Column('integer')
  quantity: number;

  @Column('int', { name: 'net_price' })
  netPrice: number;

  @Column('int', { name: 'list_price' })
  listPrice: number;
}
