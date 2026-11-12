import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('request_log')
export class RequestLogEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('varchar') url!: string;
  @Column('varchar') method!: string;
  @Column('jsonb') payload!: unknown;
  @Column('uuid', { name: 'correlation_id' }) correlationId!: string;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}
