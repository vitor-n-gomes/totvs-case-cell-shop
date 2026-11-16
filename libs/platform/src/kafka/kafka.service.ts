import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientKafka } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import type { Admin, Kafka } from 'kafkajs';
import { KAFKA_CLIENT } from './kafka.topics';

export class KafkaEvents<T extends object> {
  constructor(
    public readonly messageKey: string,
    public readonly payload: T,
    public readonly messageHeaders: Record<string, string> = {},
  ) {}
}
@Injectable()
export class KafkaService implements OnApplicationShutdown {
  private connectionPromise?: Promise<void>;
  private adminConnectionPromise?: Promise<Admin>;
  private isClosing = false;
  constructor(
    @Inject(KAFKA_CLIENT) private readonly kafkaClient: ClientKafka,
    private readonly configService: ConfigService,
  ) {}

  ensureConnected(): Promise<void> {
    if (this.isClosing) {

      return Promise.reject(new Error('Kafka shutting down'));

    }

    if (!this.connectionPromise) {

      this.connectionPromise = this.kafkaClient
        .connect()
        .then(() => undefined)
        .catch(async (error: unknown) => {
          // Nest caches a failed initial connection; close clears it so a later call can recover.
          await this.kafkaClient.close().catch(() => undefined);
          this.connectionPromise = undefined;

          throw error;
        });

    }

    return this.connectionPromise;
  }

  async produce<T extends object>(
    topic: string,
    event: KafkaEvents<T>,
  ): Promise<void> {
    await this.ensureConnected();

    await lastValueFrom(
      this.kafkaClient.emit<unknown>(topic, {
        key: event.messageKey,
        value: JSON.stringify(event.payload),
        headers: event.messageHeaders,
      }),
    );
  }

  async checkTopic(): Promise<void> {
    await this.ensureConnected();

    if (!this.adminConnectionPromise) {

      const kafkaAdmin = this.kafkaClient.unwrap<Kafka>().admin();

      this.adminConnectionPromise = kafkaAdmin
        .connect()
        .then(() => kafkaAdmin)
        .catch(async (error: unknown) => {
          await kafkaAdmin.disconnect().catch(() => undefined);
          this.adminConnectionPromise = undefined;

          throw error;
        });

    }

    const kafkaAdmin = await this.adminConnectionPromise;

    const checkoutTopic =
      this.configService.getOrThrow<string>('CHECKOUT_TOPIC');

    await kafkaAdmin.fetchTopicMetadata({
      topics: [
        this.configService.getOrThrow<string>('KAFKA_TOPIC'),
        checkoutTopic,
        `${checkoutTopic}.dlq`,
      ],
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.isClosing = true;
    await this.connectionPromise?.catch(() => undefined);

    const kafkaAdmin = await this.adminConnectionPromise?.catch(
      () => undefined,
    );

    await kafkaAdmin?.disconnect();
  }
}
