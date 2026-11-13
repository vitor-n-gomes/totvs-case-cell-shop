import { Module } from '@nestjs/common';
import { CacheModule } from '@app/platform/cache/cache.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { ShopPersistenceModule } from './shop-persistence.module';
import { GetProducts } from './catalog/get-products';
import { CatalogController } from './adapters/http/catalog.controller';
/** TODO
 * lets break down the shop-api module and create a clear structure for the products,
 * ensuring that each part of the module has a well-defined responsibility.
 * 
 */
@Module({
  imports: [
    ShopPersistenceModule,
    CacheModule,
    LoggingModule,
    ObservabilityModule,
  ],
  controllers: [CatalogController],
  providers: [GetProducts],
  exports: [GetProducts],
})
export class ShopApiModule {}
