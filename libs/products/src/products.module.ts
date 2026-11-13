import { Module } from '@nestjs/common';
import { CacheModule } from '@app/platform/cache/cache.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { ProductsPersistenceModule } from './products-persistence.module';
import { GetProductsUseCase } from './adapters/usecases/get-products.use-case';
import { ProductsController } from './adapters/http/products.controller';

@Module({
  imports: [
    ProductsPersistenceModule,
    CacheModule,
    LoggingModule,
    ObservabilityModule,
  ],
  controllers: [ProductsController],
  providers: [GetProductsUseCase],
  exports: [GetProductsUseCase],
})
export class ProductsModule {}
