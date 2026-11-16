import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientKafka } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import type { Admin, Kafka } from 'kafkajs';
import { KAFKA_CLIENT } from './kafka.topics';

export class KafkaEvents<T extends object> {
  constructor(
    public readonly key: string,
    public readonly value: T,
    public readonly headers: Record<string, string> = {},
  ) {}
}
@Injectable()
export class KafkaService implements OnApplicationShutdown {
  private connecting?: Promise<void>;
  private adminConnecting?: Promise<Admin>;
  private closing = false;
  constructor(
    @Inject(KAFKA_CLIENT) private readonly client: ClientKafka,
    private readonly config: ConfigService,
  ) {}

  ensureConnected(): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error('Kafka shutting down'));
    }

    if (!this.connecting) {
      this.connecting = this.client
        .connect()
        .then(() => undefined)
        .catch(async (error: unknown) => {
          // Nest caches a failed initial connection; close clears it so a later call can recover.
          await this.client.close().catch(() => undefined);
          this.connecting = undefined;

          throw error;
        });
    }

    return this.connecting;
  }

  async produce<T extends object>(
    topic: string,
    event: KafkaEvents<T>,
  ): Promise<void> {
    await this.ensureConnected();

    await lastValueFrom(
      this.client.emit<unknown>(topic, {
        key: event.key,
        value: JSON.stringify(event.value),
        headers: event.headers,
      }),
    );
  }

  async checkTopic(): Promise<void> {
    await this.ensureConnected();

    if (!this.adminConnecting) {
      const admin = this.client.unwrap<Kafka>().admin();

      this.adminConnecting = admin
        .connect()
        .then(() => admin)
        .catch(async (error: unknown) => {
          await admin.disconnect().catch(() => undefined);
          this.adminConnecting = undefined;

          throw error;
        });
    }

    const admin = await this.adminConnecting;
    const checkout = this.config.getOrThrow<string>('CHECKOUT_TOPIC');

    await admin.fetchTopicMetadata({
      topics: [
        this.config.getOrThrow<string>('KAFKA_TOPIC'),
        checkout,
        `${checkout}.dlq`,
      ],
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    await this.connecting?.catch(() => undefined);
    const admin = await this.adminConnecting?.catch(() => undefined);

    await admin?.disconnect();
  }
}
