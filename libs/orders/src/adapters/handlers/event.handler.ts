import { DomainEvent } from '../../messaging/order-events';

/** Processes one kind of domain event dispatched through the EventBus. */
export interface EventHandler<E extends DomainEvent = DomainEvent> {
  /** Event kind this handler subscribes to (e.g. ORDER_RESERVATION_EXPIRED). */
  kind: E['kind'];

  handle(event: E): Promise<void>;
}
