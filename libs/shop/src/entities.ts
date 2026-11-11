import { Column, Entity, PrimaryColumn } from 'typeorm';
import {
  ENVIRONMENTS,
  ORDER_STATUSES,
  PAYMENT_TYPES,
  PROCESSING_STATUSES,
} from '@app/contracts';

@Entity('order')
export class OrderEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('varchar', { name: 'payment_type' })
  paymentType!: (typeof PAYMENT_TYPES)[number];
  @Column('date', { name: 'due_date' }) dueDate!: string;
  @Column('varchar', { name: 'main_contact' }) mainContact!: string;
  @Column('varchar', { name: 'alt_contact', nullable: true }) altContact!:
    string | null;
  @Column('varchar', { name: 'payment_method' }) paymentMethod!: string;
  @Column('varchar') environment!: (typeof ENVIRONMENTS)[number];
  @Column('varchar') status!: (typeof ORDER_STATUSES)[number];
  @Column('varchar', { name: 'processing_status' })
  processingStatus!: (typeof PROCESSING_STATUSES)[number];
  @Column('varchar', { name: 'idempotency_key' }) idempotencyKey!: string;
  @Column('varchar', { name: 'request_hash' }) requestHash!: string;
  @Column('integer', { name: 'last_attempt' }) lastAttempt!: number;
  @Column('uuid', { name: 'correlation_id' }) correlationId!: string;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}
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
@Entity('idempotency_log')
export class IdempotencyLogEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'order_id' }) orderId!: string;
  @Column('varchar') action!: string;
  @Column('jsonb') reference!: Record<string, unknown>;
  @Column('varchar') step!: string;
  @Column('boolean') success!: boolean;
  @Column('text') description!: string;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}
@Entity('outbox_events')
export class OutboxEventEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'order_id' }) orderId!: string;
  @Column('varchar') topic!: string;
  @Column('jsonb') payload!: Record<string, unknown>;
  @Column('varchar') status!: 'PENDING' | 'PROCESSED';
  @Column('timestamptz', { name: 'available_at' }) availableAt!: Date;
  @Column('uuid', { name: 'lease_token', nullable: true }) leaseToken!:
    string | null;
  @Column('timestamptz', { name: 'lease_until', nullable: true })
  leaseUntil!: Date | null;
  @Column('varchar', { name: 'deduplication_key' }) deduplicationKey!: string;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}
@Entity('request_log')
export class RequestLogEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('varchar') url!: string;
  @Column('varchar') method!: string;
  @Column('jsonb') payload!: unknown;
  @Column('uuid', { name: 'correlation_id' }) correlationId!: string;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}
export const shopEntities = [
  OrderEntity,
  ProductEntity,
  OrderItemEntity,
  StockEntity,
  ReservationEntity,
  IdempotencyLogEntity,
  OutboxEventEntity,
  RequestLogEntity,
];
