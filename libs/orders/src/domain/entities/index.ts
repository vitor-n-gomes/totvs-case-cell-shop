import { OrderEntity } from './order.entity';
import { OrderItemEntity } from './order-item.entity';
import { IdempotencyLogEntity } from './idempotency-log.entity';
import { OutboxEventEntity } from './outbox-event.entity';
export {
  OrderEntity,
  OrderItemEntity,
  IdempotencyLogEntity,
  OutboxEventEntity,
};
export const orderEntities = [
  OrderEntity,
  OrderItemEntity,
  IdempotencyLogEntity,
  OutboxEventEntity,
];
