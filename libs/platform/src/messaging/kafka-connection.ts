import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel } from 'kafkajs';
import { AppLogger } from '../logging/app-logger';

@Injectable()
export class KafkaConnection implements OnModuleInit, OnApplicationShutdown {
  private connecting?: Promise<void>;
  private closing = false;
  readonly kafka;
  readonly producer;
  readonly admin;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {
    this.kafka = new Kafka({
      clientId: 'casecellshop',
      brokers: config.getOrThrow<string[]>('KAFKA_BROKERS'),
      connectionTimeout: 3000,
      requestTimeout: 5000,
      retry: { retries: 3 },
      logLevel: logLevel.ERROR,
      logCreator: () => () => this.logger.error('kafka.client.error'),
    });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: false });
    this.admin = this.kafka.admin();
  }

  onModuleInit(): void {
    void this.ensureConnected().catch(() =>
      this.logger.warn('kafka.connection.unavailable'),
    );
  }

  ensureConnected(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Kafka shutting down'));
    if (!this.connecting) {
      this.connecting = Promise.all([
        this.admin.connect(),
        this.producer.connect(),
      ])
        .then(() => undefined)
        .catch((error: unknown) => {
          this.connecting = undefined;
          throw error;
        });
    }
    return this.connecting;
  }

  async checkTopic(): Promise<void> {
    await this.ensureConnected();
    await this.admin.fetchTopicMetadata({
      topics: [
        this.config.getOrThrow<string>('KAFKA_TOPIC'),
        this.config.getOrThrow<string>('CHECKOUT_TOPIC'),
        `${this.config.getOrThrow<string>('CHECKOUT_TOPIC')}.dlq`,
      ],
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    await this.connecting?.catch(() => undefined);
    await Promise.all([this.producer.disconnect(), this.admin.disconnect()]);
  }
}
