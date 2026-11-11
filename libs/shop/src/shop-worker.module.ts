import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { MessagingModule } from '@app/platform/messaging/messaging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { ShopPersistenceModule } from './shop-persistence.module';
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
import { ActiveOrderUseCase } from './activation/active-order.use-case';
import { OutboxRelay } from './messaging/outbox-relay';
import { ExpireReservations } from './inventory/expire-reservations';
@Module({
  imports: [
    ShopPersistenceModule,
    LoggingModule,
    MessagingModule,
    ObservabilityModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    ConsumeStockReservationStep,
    ActivateOrderStep,
    UpdateErpStep,
    EmailNotificationStep,
    IntegrationSimulator,
    ActivationStepRegistry,
    OnlineActivationStrategy,
    ActiveOrderUseCase,
    OutboxRelay,
    ExpireReservations,
  ],
  exports: [ActiveOrderUseCase, OutboxRelay, ExpireReservations],
})
export class ShopWorkerModule {}
