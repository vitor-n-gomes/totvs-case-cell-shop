import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { ProductEntity } from '@app/products/domain/entities/product.entity';

@Entity('stock')
export class StockEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt: Date;
}
