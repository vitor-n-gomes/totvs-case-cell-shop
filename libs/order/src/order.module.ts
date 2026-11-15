import { Module } from '@nestjs/common';
import { InventoryModule } from '@app/products/inventory/inventory.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { OrderPersistenceModule } from './order-persistence.module';
import { OrderController } from './adapters/http/order.controller';
import { CheckoutUseCase } from './adapters/usecases/checkout.use-case';
import { CheckoutGuard } from './adapters/usecases/guards/checkout.guard';
import { GetOrderStatusUseCase } from './adapters/usecases/get-order-status.use-case';

@Module({
  imports: [
    OrderPersistenceModule,
    InventoryModule,
    LoggingModule,
    ObservabilityModule,
  ],
  controllers: [OrderController],
  providers: [CheckoutUseCase, CheckoutGuard, GetOrderStatusUseCase],
  exports: [CheckoutUseCase, GetOrderStatusUseCase],
})
export class OrderModule {}
