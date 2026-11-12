import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('product')
export class ProductEntity {
  @PrimaryGeneratedColumn('uuid') 
  id?: string;
  
  @Column('varchar') 
  name: string;
  
  @Column('varchar', { name: 'product_key' }) 
  productKey: string;

  @Column('int', { name: 'net_price' })
  netPrice: number;
  
  @Column('int', { name: 'list_price'})
  listPrice: number;
}

@Entity('stock')
export class StockEntity {
  @PrimaryGeneratedColumn('uuid') 
  id?: string;

  @Column('uuid', { name: 'product_id' })
  productId: string;
  
  @Column('integer', { name: 'physical_quantity' }) 
  physicalQuantity: number;

  @Column('integer', { name: 'reserved_quantity' }) 
  reservedQuantity: number;
}

@Entity('stock_reservation')
export class ReservationEntity {
  @PrimaryGeneratedColumn('uuid') 
  id?: string;
  
  @Column('uuid', { name: 'order_id' }) 
  orderId: string;
  
  @Column('uuid', { name: 'product_id' }) 
  productId: string;
  
  @Column('integer') 
  quantity: number;

  @Column('varchar') 
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';

  @Column('timestamptz', { name: 'expires_at' }) 
  expiresAt: Date;
}

export const shopEntities = [ProductEntity, StockEntity, ReservationEntity];
