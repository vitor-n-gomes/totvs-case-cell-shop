import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { AppLogger } from '../logging/app-logger';

@Injectable()
export class RedisConnection implements OnModuleInit, OnModuleDestroy {
  readonly redisClient;
  private isUnavailable = false;

  constructor(
    configService: ConfigService,
    private readonly appLogger: AppLogger,
  ) {
    this.redisClient = createClient({
      url: configService.getOrThrow<string>('REDIS_URL'),
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: (retryCount) =>
          Math.min(250 * (retryCount + 1), 3000),
      },
    });

    // Log once per outage instead of on every reconnect attempt.
    this.redisClient.on('error', () => {
      if (this.isUnavailable) {

        return;

      }

      this.isUnavailable = true;
      this.appLogger.warn('redis.connection.unavailable');
    });

    this.redisClient.on('ready', () => {
      if (!this.isUnavailable) {

        return;

      }

      this.isUnavailable = false;
      this.appLogger.info('redis.connection.restored');
    });
  }

  onModuleInit(): void {
    // Optional cache must not block application startup or database fallback.
    void this.redisClient
      .connect()
      .catch(() => this.appLogger.warn('redis.connection.failed'));
  }

  onModuleDestroy(): void {
    if (this.redisClient.isOpen) {

      this.redisClient.destroy();

    }
  }
}
