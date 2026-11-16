import 'reflect-metadata';
import { Logger as BootstrapLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { AppLogger } from '@app/platform/logging/app-logger';
import { HealthService } from '@app/platform/health/health.service';
import { kafkaConsumerOptions } from '@app/platform/kafka/kafka.options';
import { TopicKafkaServer } from '@app/platform/kafka/topic-kafka.server';
import {
  ORDER_EVENT_PATTERN,
  ORDER_KAFKA_TRANSPORT,
} from '@app/platform/kafka/kafka.topics';
import { ConsumerModule } from './consumer.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ConsumerModule, {
    bufferLogs: true,
    abortOnError: false,
  });

  try {

    const logger = app.get(AppLogger);

    logger.setApp('consumer');
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    const config = app.get(ConfigService);
    const health = app.get(HealthService);

    health.consumerReady = false;
    health.checkoutConsumerReady = false;
    const group = config.getOrThrow<string>('KAFKA_GROUP_ID');

    app.connectMicroservice<MicroserviceOptions>(
      {
        strategy: new TopicKafkaServer(
          kafkaConsumerOptions(config, `${group}-checkout`),
          ORDER_KAFKA_TRANSPORT,
          ORDER_EVENT_PATTERN,
          config.getOrThrow<string>('CHECKOUT_TOPIC'),
          (ready) => {
            health.checkoutConsumerReady = ready;
          },
        ),
      },
      { inheritAppConfig: true },
    );

    await app.startAllMicroservices();
    await app.listen(config.getOrThrow<number>('WORKER_PORT'), '0.0.0.0');

  } catch (error) {

    await app.close();

    throw error;

  }
}

void bootstrap().catch((error: unknown) => {
  new BootstrapLogger('Bootstrap').error(
    error instanceof Error && error.message.startsWith('Invalid configuration:')
      ? error.message
      : 'consumer.startup.failed',
  );

  process.exitCode = 1;
});
