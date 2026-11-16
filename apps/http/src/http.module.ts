import { APP_INTERCEPTOR } from '@nestjs/core';
import { ProductsModule } from '@app/products/products.module';
import { OrderModule } from '../../../libs/orders/src/order.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import {
  RequestAuditInterceptor,
  RequestAuditRepository,
} from '@app/platform/observability/request-audit';
import { HealthService } from '@app/platform/health/health.service';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigurationModule } from '@app/platform/config/configuration.module';
import { DatabaseModule } from '@app/platform/database/database.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { CorrelationMiddleware } from '@app/platform/logging/correlation.middleware';
import { HealthModule } from '@app/platform/health/health.module';

@Module({
  imports: [
    ConfigurationModule,
    ProductsModule,
    OrderModule,
    ObservabilityModule,
    LoggingModule,
    DatabaseModule,
    HealthModule,
  ],
  providers: [
    RequestAuditRepository,
    { provide: APP_INTERCEPTOR, useClass: RequestAuditInterceptor },
  ],
})
export class HttpModule implements NestModule {
  constructor(healthService: HealthService) {
    healthService.requireKafka = false;
  }

  configure(middlewareConsumer: MiddlewareConsumer): void {
    middlewareConsumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
