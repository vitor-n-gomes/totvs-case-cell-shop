import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigurationModule } from '@app/platform/config/configuration.module';
import { DatabaseModule } from '@app/platform/database/database.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { HealthModule } from '@app/platform/health/health.module';
import { OrderConsumerModule } from '@app/order/order-consumer.module';
import { DemoWorkerModule } from '@app/demo/demo-worker.module';
@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    LoggingModule,
    ObservabilityModule,
    HealthModule,
    ScheduleModule.forRoot(),
    OrderConsumerModule,
    DemoWorkerModule,
  ],
})
export class ConsumerModule {}
