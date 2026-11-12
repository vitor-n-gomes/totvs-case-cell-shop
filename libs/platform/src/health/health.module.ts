import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { KafkaModule } from '../kafka/kafka.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [CacheModule, KafkaModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
