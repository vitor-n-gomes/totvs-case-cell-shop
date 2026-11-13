import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaOptions } from '@nestjs/microservices';
import { logLevel } from 'kafkajs';
import type { KafkaConfig } from 'kafkajs';

// Producer, consumers and the metadata admin share this authentication configuration.
export function kafkaClientOptions(config: ConfigService): KafkaConfig {
  const logger = new Logger('Kafka');
  const mechanism = config.get<'plain' | 'scram-sha-256' | 'scram-sha-512'>(
    'KAFKA_SASL_MECHANISM',
  );
  const credentials = mechanism
    ? {
        username: config.getOrThrow<string>('KAFKA_SASL_USERNAME'),
        password: config.getOrThrow<string>('KAFKA_SASL_PASSWORD'),
      }
    : undefined;
  const sasl: KafkaConfig['sasl'] =
    mechanism === 'plain'
      ? { mechanism, ...credentials! }
      : mechanism === 'scram-sha-256'
        ? { mechanism, ...credentials! }
        : mechanism === 'scram-sha-512'
          ? { mechanism, ...credentials! }
          : undefined;
  return {
    clientId: 'casecellshop',
    brokers: config.getOrThrow<string[]>('KAFKA_BROKERS'),
    connectionTimeout: 3000,
    requestTimeout: 5000,
    retry: { retries: 3 },
    ssl: config.get<boolean>('KAFKA_SSL', false),
    sasl,
    logLevel: logLevel.ERROR,

    logCreator:
      () =>
      ({ log }) => {
        const { message, error, groupId } = log as {
          message?: string;
          error?: string;
          groupId?: string;
        };
        const entry = { msg: 'kafka.client.error', message, error, groupId };
        
        if (error?.includes('rebalancing')) logger.warn(entry);
        else logger.error(entry);
      },
  };
}
export function kafkaConsumerOptions(
  config: ConfigService,
  groupId: string,
): NonNullable<KafkaOptions['options']> {
  return {
    postfixId: '',
    client: kafkaClientOptions(config),
    consumer: { groupId, allowAutoTopicCreation: false },
    producer: { allowAutoTopicCreation: false },
    subscribe: { fromBeginning: true },
    send: { acks: -1 },
  };
}
