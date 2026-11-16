import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { orderEntities } from './domain/entities';
import { OrderRepository } from './repositories/order.repository';
import { OutboxRepository } from './repositories/outbox.repository';
import { IdempotencyLogRepository } from './repositories/idempotency-log.repository';

const orderRepositories = [
  OrderRepository,
  OutboxRepository,
  IdempotencyLogRepository,
];

@Module({
  imports: [TypeOrmModule.forFeature(orderEntities)],
  providers: orderRepositories,
  exports: orderRepositories,
})
export class OrderPersistenceModule {}
