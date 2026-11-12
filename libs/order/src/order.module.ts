import { Module } from '@nestjs/common';
import { InventoryModule } from '@app/shop/inventory/inventory.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { OrderPersistenceModule } from './order-persistence.module';
import { OrderController } from './adapters/http/order.controller';
import { Checkout } from './adapters/usecases/checkout';
import { GetOrderStatus } from './adapters/usecases/get-order-status';
@Module({
  imports: [
    OrderPersistenceModule,
    InventoryModule,
    LoggingModule,
    ObservabilityModule,
  ],
  controllers: [OrderController],
  providers: [Checkout, GetOrderStatus],
  exports: [Checkout, GetOrderStatus],
})
export class OrderModule {}
