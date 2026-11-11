import { Module } from '@nestjs/common';
import { CacheModule } from '@app/platform/cache/cache.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { ShopPersistenceModule } from './shop-persistence.module';
import { GetProducts } from './catalog/get-products';
import { Checkout } from './orders/checkout';
@Module({
  imports: [
    ShopPersistenceModule,
    CacheModule,
    LoggingModule,
    ObservabilityModule,
  ],
  providers: [GetProducts, Checkout],
  exports: [GetProducts, Checkout, ShopPersistenceModule],
})
export class ShopApiModule {}
