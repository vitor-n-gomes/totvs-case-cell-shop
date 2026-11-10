import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigurationModule } from '@app/platform/config/configuration.module';
import { DatabaseModule } from '@app/platform/database/database.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { CorrelationMiddleware } from '@app/platform/logging/correlation.middleware';
import { HealthModule } from '@app/platform/health/health.module';
import { DemoApiModule } from '@app/demo/demo-api.module';
import { DemoController } from './demo/demo.controller';

@Module({
  imports: [
    ConfigurationModule,
    LoggingModule,
    DatabaseModule,
    DemoApiModule,
    HealthModule,
  ],
  controllers: [DemoController],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
