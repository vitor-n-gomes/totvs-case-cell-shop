import { Module } from '@nestjs/common';
import { LoggingModule } from '../logging/logging.module';
import { KafkaConnection } from './kafka-connection';

@Module({
  imports: [LoggingModule],
  providers: [KafkaConnection],
  exports: [KafkaConnection],
})
export class MessagingModule {}
