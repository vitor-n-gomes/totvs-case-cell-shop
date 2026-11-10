import { Module } from '@nestjs/common';
import { ConfigurationModule } from '@app/platform/config/configuration.module';
import { DatabaseModule } from '@app/platform/database/database.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { MessagingModule } from '@app/platform/messaging/messaging.module';
import { HealthModule } from '@app/platform/health/health.module';
import { DemoWorkerModule } from '@app/demo/demo-worker.module';
import { DemoConsumer } from './demo/demo.consumer';

@Module({
  imports: [
    ConfigurationModule,
    LoggingModule,
    DatabaseModule,
    MessagingModule,
    DemoWorkerModule,
    HealthModule,
  ],
  providers: [DemoConsumer],
})
export class WorkerModule {}
