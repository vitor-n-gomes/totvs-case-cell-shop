import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '@app/platform/logging/app-logger';
import { DomainEvent, OrderEvent } from '../../messaging/order-events';
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
  private eventHandlers: Map<string, EventHandler[]> = new Map();

  constructor(
    private readonly appLogger: AppLogger,
    private readonly orderMessaging: OrderMessaging,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Register an event handler for a specific event kind
   * @param handler - The event handler to register
   */
  register(handler: EventHandler): void {
    const eventKind = handler.kind;

    if (!this.eventHandlers.has(eventKind)) {

      this.eventHandlers.set(eventKind, []);

    }

    const registeredHandlers = this.eventHandlers.get(eventKind)!;

    if (registeredHandlers.length > 0) {

      this.appLogger.warn(
        `Handler already registered for event kind: ${eventKind}`,
        {
          event_kind: eventKind,
          handler_count: registeredHandlers.length + 1,
        },
      );

    }

    registeredHandlers.push(handler);

    this.appLogger.info(`Handler registered for event kind: ${eventKind}`, {
      event_kind: eventKind,
      handler_count: registeredHandlers.length,
    });
  }

  /**
   * Dispatch an event to all registered handlers
   * Executes handlers in parallel and handles failures gracefully
   * @param event - The event to dispatch
   */
  async dispatch(event: DomainEvent): Promise<void> {
    const eventHandlers = this.eventHandlers.get(event.kind);

    if (!eventHandlers || eventHandlers.length === 0) {

      this.appLogger.warn(
        `No handlers registered for event kind: ${event.kind}`,
        {
          event_kind: event.kind,
        },
      );

      return;

    }

    this.appLogger.info(
      `Dispatching event to ${eventHandlers.length} handler(s)`,
      {
        event_kind: event.kind,
        handler_count: eventHandlers.length,
      },
    );

    const handlerPromises = eventHandlers.map((handler) => {
      return Promise.resolve()
        .then(() => handler.handle(event))
        .catch((error) => {
          this.appLogger.error(`Handler failed for event kind: ${event.kind}`, {
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
      topic ||
      this.configService.get<string>('KAFKA_ORDER_TOPIC', 'order.events');

    const messageKey =
      event.data.order_id ?? event.meta?.correlation_id ?? event.kind;

    this.appLogger.info(`Publishing event to Kafka`, {
      topic: kafkaTopic,
      event_kind: event.kind,
    });

    await this.orderMessaging.publish(kafkaTopic, messageKey, event);
  }
}
