import { Module } from '@nestjs/common';
import { InventoryModule } from '@app/shop/inventory/inventory.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { KafkaModule } from '@app/platform/kafka/kafka.module';
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
import { OutboxRelay } from './messaging/outbox-relay';
import { ExpireReservationsUseCase } from './adapters/usecases/expire-reservations.use-case';
@Module({
  imports: [
    OrderPersistenceModule,
    InventoryModule,
    LoggingModule,
    ObservabilityModule,
    KafkaModule,
  ],
  controllers: [OrderConsumer],
  providers: [
    OrderMessaging,
    ProcessOrderEventUseCase,
    ExpireReservationsUseCase,
    ActiveOrderUseCase,
    ConsumeStockReservationStep,
    ActivateOrderStep,
    UpdateErpStep,
    EmailNotificationStep,
    IntegrationSimulator,
    ActivationStepRegistry,
    OnlineActivationStrategy,
    OutboxRelay,
  ],
})
export class OrderConsumerModule {}
