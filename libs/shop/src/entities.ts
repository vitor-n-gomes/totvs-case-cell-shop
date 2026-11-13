import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { OrderEntity, OrderItemEntity } from '@app/order/domain/entities';

@Entity('product')
export class ProductEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar')
  name: string;

  @Column('varchar', { name: 'product_key' })
  productKey: string;

  @Column('int', { name: 'net_price' })
  netPrice: number;

  @Column('int', { name: 'list_price' })
  listPrice: number;

  @OneToOne(() => StockEntity, (stock) => stock.product)
  stock?: Relation<StockEntity>;

  @OneToMany(() => OrderItemEntity, (item) => item.product)
  orderItems?: Relation<OrderItemEntity>[];

  @OneToMany(() => ReservationEntity, (reservation) => reservation.product)
  reservations?: Relation<ReservationEntity>[];
}

@Entity('stock')
export class StockEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_stock_product_id', { unique: true })
  @Column('uuid', { name: 'product_id' })
  productId: string;

  @OneToOne(() => ProductEntity, (product) => product.stock, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<ProductEntity>;

  @Column('integer', { name: 'physical_quantity' })
  physicalQuantity: number;

  @Column('integer', { name: 'reserved_quantity' })
  reservedQuantity: number;
}

@Entity('stock_reservation')
export class ReservationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

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
}

export const shopEntities = [ProductEntity, StockEntity, ReservationEntity];
