import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { OrderEntity } from '@app/order/domain/entities';
import { ProductEntity } from '@app/products/domain/entities/product.entity';

@Entity('stock_reservation')
export class ReservationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_stock_reservation_order_id')
  @Column('uuid', { name: 'order_id' })
  orderId: string;

  @ManyToOne(() => OrderEntity, (order) => order.reservations, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<OrderEntity>;

  @Index('idx_stock_reservation_product_id')
  @Column('uuid', { name: 'product_id' })
  productId: string;

  @ManyToOne(() => ProductEntity, (product) => product.reservations, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<ProductEntity>;

  @Column('integer')
  quantity: number;

  @Column('varchar')
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';

  @Column('timestamptz', { name: 'expires_at' })
  expiresAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt: Date;
}
