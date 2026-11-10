import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { MessagingModule } from '../messaging/messaging.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [CacheModule, MessagingModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
