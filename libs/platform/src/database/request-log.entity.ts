import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('request_log')
export class RequestLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar')
  url: string;

  @Column('varchar')
  method: string;

  @Column('jsonb')
  payload: unknown;

  @Column('uuid', { name: 'correlation_id' })
  correlationId: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
