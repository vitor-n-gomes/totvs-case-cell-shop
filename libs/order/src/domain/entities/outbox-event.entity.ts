import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { OrderEntity } from './order.entity';

@Entity('outbox_events')
export class OutboxEventEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index('idx_outbox_events_order_id')
  @Column('uuid', { name: 'order_id' })
  orderId!: string;
  @ManyToOne(() => OrderEntity, (order) => order.outboxEvents, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<OrderEntity>;
  @Column('varchar') topic!: string;
  @Column('jsonb') payload!: Record<string, unknown>;
  @Column('varchar', { default: 'PENDING' }) status!: 'PENDING' | 'PROCESSED';
  @Column('timestamptz', { name: 'available_at' }) availableAt!: Date;
  @Column('uuid', { name: 'lease_token', nullable: true }) leaseToken!:
    string | null;
  @Column('timestamptz', { name: 'lease_until', nullable: true })
  leaseUntil!: Date | null;
  @Column('varchar', { name: 'deduplication_key' }) deduplicationKey!: string;
  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;
}
