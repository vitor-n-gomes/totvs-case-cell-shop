import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppLogger } from '@app/platform/logging/app-logger';
import { CheckoutInitiatedHandler } from '../usecases/event-handlers/checkout-initiated.handler';
import { ReservationExpiredHandler } from '../usecases/event-handlers/reservation-expired.handler';
import { OrderActivatedHandler } from './order-activated.handler';
import { EventBus } from './event.bus';

/**
 * Registry for managing event handlers in the EventBus
 * Handles registration of all event handlers and provides initialization logic
 */
@Injectable()
export class HandlersRegistry implements OnModuleInit {
  constructor(
    private readonly logger: AppLogger,
    private readonly checkoutInitiatedHandler: CheckoutInitiatedHandler,
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
    const handlers = [
      this.checkoutInitiatedHandler,
      this.reservationExpiredHandler,
      this.orderActivatedHandler,
    ];

    let registeredCount = 0;

    handlers.forEach((handler) => {
      try {
        eventBus.register(handler as any);
        registeredCount++;
      } catch (error) {
        this.logger.warn('handlers.registry.registration_failed', {
          handlerName: handler.constructor.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.logger.info('handlers.registry.initialized', {
      registeredHandlers: registeredCount,
      totalHandlers: handlers.length,
    });

    if (registeredCount !== handlers.length) {
      this.logger.warn('handlers.registry.incomplete_registration', {
        registeredHandlers: registeredCount,
        totalHandlers: handlers.length,
        failedHandlers: handlers.length - registeredCount,
      });
    }
  }
}
