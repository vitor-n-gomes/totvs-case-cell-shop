import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('outbox_events')
export class OutboxEventEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('uuid', { name: 'order_id' }) orderId!: string;
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
