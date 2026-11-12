import { DemoConsumer } from './adapters/demo.consumer';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { Module } from '@nestjs/common';
import { DemoPersistenceModule } from './demo-persistence.module';
import { ReceiveMessage } from './use-cases/receive-message';

@Module({
  imports: [DemoPersistenceModule, LoggingModule],
  controllers: [DemoConsumer],
  providers: [ReceiveMessage],
  exports: [ReceiveMessage],
})
export class DemoWorkerModule {}
