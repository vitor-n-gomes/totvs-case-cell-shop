import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { AppLogger } from '../logging/app-logger';

@Injectable()
export class RedisConnection implements OnModuleInit, OnModuleDestroy {
  readonly client;
  private unavailable = false;

  constructor(
    config: ConfigService,
    private readonly logger: AppLogger,
  ) {
    this.client = createClient({
      url: config.getOrThrow<string>('REDIS_URL'),
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: (retries) => Math.min(250 * (retries + 1), 3000),
      },
    });

    // Log once per outage instead of on every reconnect attempt.
    this.client.on('error', () => {
      if (this.unavailable) {

        return;

      }

      this.unavailable = true;
      this.logger.warn('redis.connection.unavailable');
    });

    this.client.on('ready', () => {
      if (!this.unavailable) {

        return;

      }

      this.unavailable = false;
      this.logger.info('redis.connection.restored');
    });
  }

  onModuleInit(): void {
    // Optional cache must not block application startup or database fallback.
    void this.client
      .connect()
      .catch(() => this.logger.warn('redis.connection.failed'));
  }

  onModuleDestroy(): void {
    if (this.client.isOpen) {

      this.client.destroy();

    }
  }
}
