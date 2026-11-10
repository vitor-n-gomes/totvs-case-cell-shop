import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('demo_message_receipts')
export class MessageReceiptEntity {
  @PrimaryColumn('uuid', { name: 'event_id' }) eventId!: string;
  @Column('smallint', { name: 'schema_version' }) schemaVersion!: 1;
  @Column('uuid', { name: 'correlation_id' }) correlationId!: string;
  @Column('varchar', { length: 500 }) message!: string;
  @Column('timestamptz', { name: 'occurred_at' }) occurredAt!: Date;
  @Column('timestamptz', { name: 'received_at' }) receivedAt!: Date;
}
