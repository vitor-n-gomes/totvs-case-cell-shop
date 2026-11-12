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
  @Column('varchar', { default: 'PENDING' })
  status!: (typeof ORDER_STATUSES)[number];
  @Column('varchar', { name: 'processing_status', default: 'PENDING' })
  processingStatus!: (typeof PROCESSING_STATUSES)[number];
  @Column('varchar', { name: 'idempotency_key' }) idempotencyKey!: string;
  @Column('varchar', { name: 'request_hash' }) requestHash!: string;
  @Column('integer', { name: 'last_attempt', default: 0 }) lastAttempt!: number;
  @Column('uuid', { name: 'correlation_id' }) correlationId!: string;
  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;
}
