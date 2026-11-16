import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ReservationExpiredHandler } from '../usecases/event-handlers/reservation-expired.handler';
import { OrderActivatedHandler } from './order-activated.handler';
import { EventHandler } from './event.handler';
import { EventBus } from './event.bus';

/**
 * Registry for managing event handlers in the EventBus
 * Handles registration of all event handlers and provides initialization logic
 */
@Injectable()
export class HandlersRegistry implements OnModuleInit {
  constructor(
    private readonly appLogger: AppLogger,
    private readonly reservationExpiredHandler: ReservationExpiredHandler,
    private readonly orderActivatedHandler: OrderActivatedHandler,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Initialize module and register all handlers
   */
  onModuleInit(): void {
    this.registerAll(this.eventBus);
  }

  /**
   * Register all event handlers with the EventBus
   * Logs initialization status and validates successful registration
   * @param eventBus - The EventBus instance to register handlers with
   */
  registerAll(eventBus: EventBus): void {
    // CheckoutInitiatedHandler is not an EventHandler; ProcessOrderEventUseCase invokes it directly.
    const eventHandlers: EventHandler[] = [
      this.reservationExpiredHandler,
      this.orderActivatedHandler,
    ];

    let registeredHandlerCount = 0;

    eventHandlers.forEach((handler) => {
      try {

        eventBus.register(handler);
        registeredHandlerCount++;

      } catch (error) {

        this.appLogger.warn('handlers.registry.registration_failed', {
          handler_name: handler.constructor.name,
          error: error instanceof Error ? error.message : String(error),
        });

      }
    });

    this.appLogger.info('handlers.registry.initialized', {
      registered_handlers: registeredHandlerCount,
      total_handlers: eventHandlers.length,
    });

    if (registeredHandlerCount !== eventHandlers.length) {

      this.appLogger.warn('handlers.registry.incomplete_registration', {
        registered_handlers: registeredHandlerCount,
        total_handlers: eventHandlers.length,
        failed_handlers: eventHandlers.length - registeredHandlerCount,
      });

    }
  }
}
