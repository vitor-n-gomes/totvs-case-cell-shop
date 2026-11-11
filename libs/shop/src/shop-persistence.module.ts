import { Module } from '@nestjs/common';
import { ProductRepository } from './catalog/product.repository';
import { OrderRepository } from './orders/order.repository';
import { StockRepository } from './inventory/stock.repository';
import { ReservationRepository } from './inventory/reservation.repository';
import { OutboxRepository } from './messaging/outbox.repository';
import { IdempotencyLogRepository } from './activation/idempotency-log.repository';
const repositories = [
  ProductRepository,
  OrderRepository,
  StockRepository,
  ReservationRepository,
  OutboxRepository,
  IdempotencyLogRepository,
];
@Module({ providers: repositories, exports: repositories })
export class ShopPersistenceModule {}
