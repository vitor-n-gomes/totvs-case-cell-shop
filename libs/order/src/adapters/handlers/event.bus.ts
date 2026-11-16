import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '@app/platform/logging/app-logger';
import { DomainEvent, OrderEvent } from '@app/order/messaging/order-events';
import { EventHandler } from './event.handler';
import { OrderMessaging } from '../order.messaging';

/**
 * Interface for the EventBus service
 * Defines methods for registering handlers and dispatching events
 */
export interface IEventBus {
  /**
   * Register an event handler for a specific event kind
   * @param handler - The event handler to register
   */
  register(handler: EventHandler): void;

  /**
   * Dispatch an event to all registered handlers
   * @param event - The event to dispatch
   */
  dispatch(event: DomainEvent): Promise<void>;

  /**
   * Publish an event to Kafka
   * @param event - The event to publish
   * @param topic - Optional Kafka topic; uses default if not provided
   */
  publish(event: OrderEvent, topic?: string): Promise<void>;
}

/**
 * Central EventBus service for orchestrating event handlers
 * Manages handler registration, dispatch, and publication
 */
@Injectable()
export class EventBus implements IEventBus {
  /**
   * Registry mapping event kinds to their handlers
   */
  private handlers: Map<string, EventHandler[]> = new Map();

  constructor(
    private readonly logger: AppLogger,
    private readonly messaging: OrderMessaging,
    private readonly config: ConfigService,
  ) {}

  /**
   * Register an event handler for a specific event kind
   * @param handler - The event handler to register
   */
  register(handler: EventHandler): void {
    const kind = handler.kind;

    if (!this.handlers.has(kind)) {
      this.handlers.set(kind, []);
    }

    const existingHandlers = this.handlers.get(kind)!;

    if (existingHandlers.length > 0) {
      this.logger.warn(`Handler already registered for event kind: ${kind}`, {
        event_kind: kind,
        handler_count: existingHandlers.length + 1,
      });
    }

    existingHandlers.push(handler);

    this.logger.info(`Handler registered for event kind: ${kind}`, {
      event_kind: kind,
      handler_count: existingHandlers.length,
    });
  }

  /**
   * Dispatch an event to all registered handlers
   * Executes handlers in parallel and handles failures gracefully
   * @param event - The event to dispatch
   */
  async dispatch(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.kind);

    if (!handlers || handlers.length === 0) {
      this.logger.warn(`No handlers registered for event kind: ${event.kind}`, {
        event_kind: event.kind,
      });

      return;
    }

    this.logger.info(`Dispatching event to ${handlers.length} handler(s)`, {
      event_kind: event.kind,
      handler_count: handlers.length,
    });

    const handlerPromises = handlers.map((handler) => {
      return Promise.resolve()
        .then(() => handler.handle(event))
        .catch((error) => {
          this.logger.error(`Handler failed for event kind: ${event.kind}`, {
            event_kind: event.kind,
            error: error instanceof Error ? error.message : String(error),
            handler_name: handler.constructor.name,
          });
          // Do not propagate error - continue processing other handlers
        });
    });

    await Promise.all(handlerPromises);
  }

  /**
   * Publish an event to Kafka
   * @param event - The event to publish
   * @param topic - Optional Kafka topic; uses default if not provided
   */
  async publish(event: OrderEvent, topic?: string): Promise<void> {
    const kafkaTopic =
      topic || this.config.get<string>('KAFKA_ORDER_TOPIC', 'order.events');

    const key = event.data.order_id ?? event.meta?.correlation_id ?? event.kind;

    this.logger.info(`Publishing event to Kafka`, {
      topic: kafkaTopic,
      event_kind: event.kind,
    });

    await this.messaging.publish(kafkaTopic, key, event);
  }
}
