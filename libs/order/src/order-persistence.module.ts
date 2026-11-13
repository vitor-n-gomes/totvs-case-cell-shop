import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { orderEntities } from './domain/entities';
import { OrderRepository } from './repositories/order.repository';
import { OutboxRepository } from './repositories/outbox.repository';
import { IdempotencyLogRepository } from './repositories/idempotency-log.repository';
const repositories = [
  OrderRepository,
  OutboxRepository,
  IdempotencyLogRepository,
];
@Module({
  imports: [TypeOrmModule.forFeature(orderEntities)],
  providers: repositories,
  exports: repositories,
})
export class OrderPersistenceModule {}
