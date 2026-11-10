import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel } from 'kafkajs';
import { AppLogger } from '../logging/app-logger';

@Injectable()
export class KafkaConnection implements OnModuleInit, OnModuleDestroy {
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

  async onModuleInit(): Promise<void> {
    await this.admin.connect();
    await this.producer.connect();
    await this.checkTopic();
  }

  async checkTopic(): Promise<void> {
    await this.admin.fetchTopicMetadata({
      topics: [this.config.getOrThrow<string>('KAFKA_TOPIC')],
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.producer.disconnect(), this.admin.disconnect()]);
  }
}
