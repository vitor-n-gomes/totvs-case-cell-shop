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
import { OrderConsumerExceptionFilter } from '../../libs/orders/src/adapters/consumer/order-consumer-exception.filter';
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

    const appLogger = app.get(AppLogger);

    appLogger.setApp('consumer');
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    app.useGlobalFilters(app.get(OrderConsumerExceptionFilter));
    const configService = app.get(ConfigService);
    const healthService = app.get(HealthService);

    healthService.checkoutConsumerReady = false;
    const consumerGroupId = configService.getOrThrow<string>('KAFKA_GROUP_ID');

    app.connectMicroservice<MicroserviceOptions>(
      {
        strategy: new TopicKafkaServer(
          kafkaConsumerOptions(configService, `${consumerGroupId}-checkout`),
          ORDER_KAFKA_TRANSPORT,
          ORDER_EVENT_PATTERN,
          configService.getOrThrow<string>('CHECKOUT_TOPIC'),
          (isConsumerReady) => {
            healthService.checkoutConsumerReady = isConsumerReady;
          },
        ),
      },
      { inheritAppConfig: true },
    );

    await app.startAllMicroservices();

    await app.listen(
      configService.getOrThrow<number>('WORKER_PORT'),
      '0.0.0.0',
    );

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
