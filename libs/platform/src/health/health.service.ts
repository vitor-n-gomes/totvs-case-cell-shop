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
  private shuttingDown = false;

  constructor(
    private readonly database: DataSource,
    private readonly kafka: KafkaService,
    private readonly redis: RedisConnection,
  ) {}

  async readiness(): Promise<{
    ready: boolean;
    checks: Record<string, string>;
  }> {
    const [database, kafka] = await Promise.allSettled([
      this.database.query('SELECT 1'),
      this.requireKafka ? this.kafka.checkTopic() : Promise.resolve(),
    ]);
    const checks: Record<string, string> = {
      postgres: database.status === 'fulfilled' ? 'up' : 'down',
      kafka: kafka.status === 'fulfilled' ? 'up' : 'down',
    };
    if (this.consumerReady !== undefined)
      checks.consumer = this.consumerReady ? 'up' : 'down';
    if (!this.requireKafka) delete checks.kafka;
    if (this.checkoutConsumerReady !== undefined)
      checks.checkoutConsumer = this.checkoutConsumerReady ? 'up' : 'down';
    if (this.schedulerReady !== undefined)
      checks.scheduler = this.schedulerReady ? 'up' : 'down';
    return {
      ready:
        !this.shuttingDown &&
        Object.values(checks).every((value) => value === 'up'),
      checks,
    };
  }

  async cacheStatus(): Promise<{ redis: 'up' | 'down'; required: false }> {
    try {
      if (!this.redis.client.isReady) return { redis: 'down', required: false };
      await this.redis.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
        .ping();
      return { redis: 'up', required: false };
    } catch {
      return { redis: 'down', required: false };
    }
  }

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }
}
