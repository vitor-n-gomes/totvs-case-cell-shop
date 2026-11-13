import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigurationModule } from '@app/platform/config/configuration.module';
import { DatabaseModule } from '@app/platform/database/database.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { HealthModule } from '@app/platform/health/health.module';
import { KafkaModule } from '@app/platform/kafka/kafka.module';
import { OrderConsumerModule } from '@app/order/order-consumer.module';
import { OrderMessaging } from '@app/order/adapters/order.messaging';

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    LoggingModule,
    ObservabilityModule,
    HealthModule,
    ScheduleModule.forRoot(),
    KafkaModule,
    OrderConsumerModule,
  ],
  providers: [OrderMessaging],
})
export class SchedulerModule {}
