import { Module } from '@nestjs/common';
import { InventoryModule } from '@app/products/inventory/inventory.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { KafkaModule } from '@app/platform/kafka/kafka.module';
import { CacheModule } from '@app/platform/cache/cache.module';
import { OrderPersistenceModule } from './order-persistence.module';
import { OrderConsumer } from './adapters/consumer/order.consumer';
import { OrderMessaging } from './adapters/order.messaging';
import { ProcessOrderEventUseCase } from './adapters/usecases/process-order-event.use-case';
import { ActiveOrderUseCase } from './activation/active-order.use-case';
import {
  ConsumeStockReservationStep,
  ActivateOrderStep,
} from './activation/steps/database-steps';
import {
  UpdateErpStep,
  EmailNotificationStep,
  IntegrationSimulator,
} from './activation/steps/integration-steps';
import { ActivationStepRegistry } from './activation/registries/activation-step.registry';
import { OnlineActivationStrategy } from './activation/strategies/online-activation.strategy';
import { OrderActivationGuard } from './activation/guards/order-activation.guard';
import { ActivationFailureHandler } from './activation/handlers/activation-failure.handler';
import { OutboxRelay } from './messaging/outbox-relay';
import { EventBus } from './adapters/handlers/event.bus';
import { HandlersRegistry } from './adapters/handlers/handlers.registry';
import { CheckoutInitiatedHandler } from './adapters/usecases/event-handlers/checkout-initiated.handler';
import { ReservationExpiredHandler } from './adapters/usecases/event-handlers/reservation-expired.handler';
import { OrderActivatedHandler } from './adapters/handlers/order-activated.handler';

@Module({
  imports: [
    OrderPersistenceModule,
    InventoryModule,
    LoggingModule,
    ObservabilityModule,
    KafkaModule,
    CacheModule,
  ],
  controllers: [OrderConsumer],
  providers: [
    OrderMessaging,
    ProcessOrderEventUseCase,
    ActiveOrderUseCase,
    ConsumeStockReservationStep,
    ActivateOrderStep,
    UpdateErpStep,
    EmailNotificationStep,
    IntegrationSimulator,
    ActivationStepRegistry,
    OnlineActivationStrategy,
    OrderActivationGuard,
    ActivationFailureHandler,
    OutboxRelay,
    EventBus,
    HandlersRegistry,
    CheckoutInitiatedHandler,
    ReservationExpiredHandler,
    OrderActivatedHandler,
  ],
  exports: [
    ProcessOrderEventUseCase,
    EventBus,
    HandlersRegistry,
    OrderMessaging,
  ],
})
export class OrderConsumerModule {}
