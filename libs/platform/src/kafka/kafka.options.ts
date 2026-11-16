import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaOptions } from '@nestjs/microservices';
import { logLevel } from 'kafkajs';
import type { KafkaConfig } from 'kafkajs';

// Producer, consumers and the metadata admin share this authentication configuration.
export function kafkaClientOptions(configService: ConfigService): KafkaConfig {
  const kafkaLogger = new Logger('Kafka');

  const saslMechanism = configService.get<
    'plain' | 'scram-sha-256' | 'scram-sha-512'
  >('KAFKA_SASL_MECHANISM');

  const saslCredentials = saslMechanism
    ? {
        username: configService.getOrThrow<string>('KAFKA_SASL_USERNAME'),
        password: configService.getOrThrow<string>('KAFKA_SASL_PASSWORD'),
      }
    : undefined;

  const sasl: KafkaConfig['sasl'] =
    saslMechanism === 'plain'
      ? { mechanism: saslMechanism, ...saslCredentials! }
      : saslMechanism === 'scram-sha-256'
        ? { mechanism: saslMechanism, ...saslCredentials! }
        : saslMechanism === 'scram-sha-512'
          ? { mechanism: saslMechanism, ...saslCredentials! }
          : undefined;

  return {
    clientId: 'casecellshop',
    brokers: configService.getOrThrow<string[]>('KAFKA_BROKERS'),
    connectionTimeout: 3000,
    requestTimeout: 5000,
    retry: { retries: 3 },
    ssl: configService.get<boolean>('KAFKA_SSL', false),
    sasl,
    logLevel: logLevel.ERROR,

    logCreator:
      () =>
      ({ log }) => {
        const { message, error, groupId } = log as {
          message?: string;
          error?: unknown;
          groupId?: string;
        };

        const errorMessage =
          typeof error === 'string'
            ? error
            : error instanceof Error
              ? error.message
              : undefined;

        const logEntry = {
          msg: 'kafka.client.error',
          message,
          error: errorMessage,
          groupId,
        };

        if (errorMessage?.includes('rebalancing')) {

          kafkaLogger.warn(logEntry);

        } else {

          kafkaLogger.error(logEntry);

        }
      },
  };
}

export function kafkaConsumerOptions(
  configService: ConfigService,
  groupId: string,
): NonNullable<KafkaOptions['options']> {
  return {
    postfixId: '',
    client: kafkaClientOptions(configService),
    consumer: { groupId, allowAutoTopicCreation: false },
    producer: { allowAutoTopicCreation: false },
    subscribe: { fromBeginning: true },
    send: { acks: -1 },
  };
}
