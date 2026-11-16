import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigurationModule } from '@app/platform/config/configuration.module';
import { DatabaseModule } from '@app/platform/database/database.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import { KafkaModule } from '@app/platform/kafka/kafka.module';
import { OrderSchedulerModule } from '../../libs/orders/src/order-scheduler.module';

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    LoggingModule,
    ObservabilityModule,
    KafkaModule,
    ScheduleModule.forRoot(),
    OrderSchedulerModule,
  ],
})
export class SchedulerModule {}
