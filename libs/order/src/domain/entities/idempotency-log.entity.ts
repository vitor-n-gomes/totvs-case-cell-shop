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

@Entity('idempotency_log')
export class IdempotencyLogEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index('idx_idempotency_log_order_id')
  @Column('uuid', { name: 'order_id' })
  orderId!: string;
  @ManyToOne(() => OrderEntity, (order) => order.idempotencyLogs, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<OrderEntity>;
  @Column('varchar') action!: string;
  @Column('jsonb') reference!: Record<string, unknown>;
  @Column('varchar') step!: string;
  @Column('boolean') success!: boolean;
  @Column('text') description!: string;
  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;
}
