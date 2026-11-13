import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { OrderItemEntity } from '@app/order/domain/entities';
import {
  ReservationEntity,
  StockEntity,
} from '@app/products/inventory/domain/entities';

@Entity('product')
export class ProductEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar')
  name: string;

  @Column('varchar', { name: 'product_key' })
  productKey: string;

  @Column('int', { name: 'net_price' })
  netPrice: number;

  @Column('int', { name: 'list_price' })
  listPrice: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt: Date;

  @OneToOne(() => StockEntity, (stock) => stock.product)
  stock?: Relation<StockEntity>;

  @OneToMany(() => OrderItemEntity, (item) => item.product)
  orderItems?: Relation<OrderItemEntity>[];

  @OneToMany(() => ReservationEntity, (reservation) => reservation.product)
  reservations?: Relation<ReservationEntity>[];
}
