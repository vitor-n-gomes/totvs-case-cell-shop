import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import { Environment, OrderStatus, PaymentType, ProcessingStatus } from "../shared/types/order.type";

@Entity({ name: "order" })
export class OrderEntity {
    @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: "pk_order" })
    id: string;

    @Column('varchar', { name: 'payment_type' })
    paymentType: PaymentType;

    @Column('date', { name: 'due_date' })
    dueDate: string;

    @Column('varchar', { name: 'main_contact' })
    mainContact: string;

    @Column('varchar', { name: 'alt_contact', nullable: true })
    altContact?: string;

    @Column('varchar', { name: 'payment_method' })
    paymentMethod: string;

    @Column('varchar')
    environment: Environment;

    @Column('varchar')
    status: OrderStatus;

    @Column('varchar', { name: 'processing_status' })
    processingStatus: ProcessingStatus;

    @Column('varchar', { name: 'idempotency_key' })
    idempotencyKey: string;

    @Column('varchar', { name: 'request_hash' })
    requestHash: string;

    @Column('integer', { name: 'last_attempt' })
    lastAttempt: number;

    @Column('uuid', { name: 'correlation_id' })
    correlationId: string;

    @Column('timestamptz', { name: 'created_at' })
    createdAt: Date;

    @Column('timestamptz', { name: 'created_at' })
    updateddAt: Date;

    @Column('timestamptz', { name: 'created_at' })
    deletedAt: Date;
}