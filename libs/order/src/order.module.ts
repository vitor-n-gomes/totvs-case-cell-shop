import { Module } from '@nestjs/common';
import { InventoryModule } from '@app/shop/inventory/inventory.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { OrderPersistenceModule } from './order-persistence.module';
import { OrderController } from './adapters/http/order.controller';
import { CheckoutUseCase } from './adapters/usecases/checkout.use-case';
import { GetOrderStatusUseCase } from './adapters/usecases/get-order-status.use-case';
import { EventBus } from './adapters/handlers/event.bus';
import { HandlersRegistry } from './adapters/handlers/handlers.registry';

@Module({
  imports: [
    OrderPersistenceModule,
    InventoryModule,
    LoggingModule,
    ObservabilityModule,
  ],
  controllers: [OrderController],
  providers: [CheckoutUseCase, GetOrderStatusUseCase, EventBus, HandlersRegistry],
  exports: [
    CheckoutUseCase,
    GetOrderStatusUseCase,
    EventBus,
    HandlersRegistry,
  ],
})
export class OrderModule {}
