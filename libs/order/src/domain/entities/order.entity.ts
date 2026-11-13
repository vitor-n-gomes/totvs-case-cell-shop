import {
  Column,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { ReservationEntity } from '@app/shop/entities';
import { OrderItemEntity } from './order-item.entity';
import { IdempotencyLogEntity } from './idempotency-log.entity';
import { OutboxEventEntity } from './outbox-event.entity';
import {
  Environment,
  OrderStatus,
  PaymentType,
  ProcessingStatus,
} from '@app/contracts';

@Entity('order')
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({
    type: 'varchar',
    length: 16,
    name: 'payment_type',
  })
  paymentType: PaymentType;
  @Column('date', { name: 'due_date' })
  dueDate: string;
  @Column('varchar', { name: 'main_contact' })
  mainContact: string;
  @Column('varchar', { name: 'alt_contact', nullable: true })
  altContact?: string;
  @Column('varchar', { name: 'payment_method' })
  paymentMethod: string;
  @Column({
    type: 'varchar',
    length: 16,
  })
  environment: Environment;
  @Column({
    type: 'varchar',
    length: 16,
    default: OrderStatus.Pending,
  })
  status: OrderStatus;
  @Column({
    type: 'varchar',
    length: 16,
    name: 'processing_status',
    default: ProcessingStatus.Pending,
  })
  processingStatus: ProcessingStatus;
  @Column('varchar', { name: 'idempotency_key' })
  idempotencyKey: string;
  @Column('varchar', { name: 'request_hash' })
  requestHash: string;
  @Column('integer', { name: 'last_attempt', default: 0 })
  lastAttempt: number;
  @Column('uuid', { name: 'correlation_id' })
  correlationId: string;
  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => OrderItemEntity, (item) => item.order)
  items?: Relation<OrderItemEntity>[];
  @OneToMany(() => ReservationEntity, (reservation) => reservation.order)
  reservations?: Relation<ReservationEntity>[];
  @OneToMany(() => IdempotencyLogEntity, (log) => log.order)
  idempotencyLogs?: Relation<IdempotencyLogEntity>[];
  @OneToMany(() => OutboxEventEntity, (event) => event.order)
  outboxEvents?: Relation<OutboxEventEntity>[];
}
