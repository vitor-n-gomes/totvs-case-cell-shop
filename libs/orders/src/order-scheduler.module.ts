import { Module } from '@nestjs/common';
import { InventoryModule } from '@app/products/inventory/inventory.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { KafkaModule } from '@app/platform/kafka/kafka.module';
import { OrderMessaging } from './adapters/order.messaging';
import { ExpireReservationsUseCase } from './adapters/usecases/expire-reservations.use-case';

/** Producer-only wiring for the scheduler app: no consumers, no state changes. */
@Module({
  imports: [InventoryModule, LoggingModule, ObservabilityModule, KafkaModule],
  providers: [OrderMessaging, ExpireReservationsUseCase],
  exports: [ExpireReservationsUseCase],
})
export class OrderSchedulerModule {}
