import { OrderEvent } from '@app/order/domain/events';

/**
 * Generic interface for event handlers in the EventBus system
 * Each handler is responsible for processing a specific event type
 *
 * @template T - The event data type
 */
export interface EventHandler<T = any> {
  /**
   * Event type identifier (e.g., "order.activated", "reservation.expired")
   * Used to route events to the correct handler
   */
  kind: string;

  /**
   * Processes the incoming event
   * @param event - The event to be handled
   */
  handle(event: OrderEvent<T>): Promise<void>;
}

/**
 * Type for EventHandler class constructor
 * Useful for handler registry and dependency injection
 */
export type EventHandlerClass<T = any> = new (...args: any[]) => EventHandler<T>;
