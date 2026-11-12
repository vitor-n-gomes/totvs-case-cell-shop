import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('idempotency_log')
export class IdempotencyLogEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'order_id' }) orderId!: string;
  @Column('varchar') action!: string;
  @Column('jsonb') reference!: Record<string, unknown>;
  @Column('varchar') step!: string;
  @Column('boolean') success!: boolean;
  @Column('text') description!: string;
  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;
}
