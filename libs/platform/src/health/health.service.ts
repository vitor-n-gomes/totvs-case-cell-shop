import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { KafkaService } from '../kafka/kafka.service';
import { RedisConnection } from '../cache/redis-connection';

@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  requireKafka = true;
  checkoutConsumerReady: boolean | undefined;
  consumerReady: boolean | undefined;
  schedulerReady: boolean | undefined;
  private isShuttingDown = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly kafkaService: KafkaService,
    private readonly redisConnection: RedisConnection,
  ) {}

  async readiness(): Promise<{
    ready: boolean;
    checks: Record<string, string>;
  }> {
    const [databaseCheckResult, kafkaCheckResult] = await Promise.allSettled([
      this.dataSource.query('SELECT 1'),
      this.requireKafka ? this.kafkaService.checkTopic() : Promise.resolve(),
    ]);

    const readinessChecks: Record<string, string> = {
      postgres: databaseCheckResult.status === 'fulfilled' ? 'up' : 'down',
      kafka: kafkaCheckResult.status === 'fulfilled' ? 'up' : 'down',
    };

    if (this.consumerReady !== undefined) {

      readinessChecks.consumer = this.consumerReady ? 'up' : 'down';

    }

    if (!this.requireKafka) {

      delete readinessChecks.kafka;

    }

    if (this.checkoutConsumerReady !== undefined) {

      readinessChecks.checkoutConsumer = this.checkoutConsumerReady
        ? 'up'
        : 'down';

    }

    if (this.schedulerReady !== undefined) {

      readinessChecks.scheduler = this.schedulerReady ? 'up' : 'down';

    }

    return {
      ready:
        !this.isShuttingDown &&
        Object.values(readinessChecks).every(
          (checkStatus) => checkStatus === 'up',
        ),
      checks: readinessChecks,
    };
  }

  async cacheStatus(): Promise<{ redis: 'up' | 'down'; required: false }> {
    try {

      if (!this.redisConnection.redisClient.isReady) {

        return { redis: 'down', required: false };

      }

      await this.redisConnection.redisClient
        .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
        .ping();

      return { redis: 'up', required: false };

    } catch {

      return { redis: 'down', required: false };

    }
  }

  beforeApplicationShutdown(): void {
    this.isShuttingDown = true;
  }
}
