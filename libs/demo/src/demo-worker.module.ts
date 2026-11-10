import { Module } from '@nestjs/common';
import { DemoPersistenceModule } from './demo-persistence.module';
import { ReceiveMessage } from './use-cases/receive-message';

@Module({
  imports: [DemoPersistenceModule],
  providers: [ReceiveMessage],
  exports: [ReceiveMessage],
})
export class DemoWorkerModule {}
