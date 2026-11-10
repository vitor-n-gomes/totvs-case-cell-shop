import { Module } from '@nestjs/common';
import { LoggingModule } from '../logging/logging.module';
import { RedisConnection } from './redis-connection';

@Module({
  imports: [LoggingModule],
  providers: [RedisConnection],
  exports: [RedisConnection],
})
export class CacheModule {}
