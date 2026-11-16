// Load database metadata before repositories: the entity barrels are cyclic.
import { databaseOptions } from '@app/platform/database/options';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { parse } from 'dotenv';
import { Kafka, KafkaMessage } from 'kafkajs';
import { DataSource } from 'typeorm';
import { OrderModule } from '@app/order/order.module';
import { OrderConsumerModule } from '@app/order/order-consumer.module';
import { OrderSchedulerModule } from '@app/order/order-scheduler.module';
import { OrderMessaging } from '@app/order/adapters/order.messaging';
import { OrderConsumerExceptionFilter } from '@app/order/adapters/consumer/order-consumer-exception.filter';
import { ExpireReservationsUseCase } from '@app/order/adapters/usecases/expire-reservations.use-case';
import { OutboxRelay } from '@app/order/messaging/outbox-relay';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import {
  Environment,
  validateEnvironment,
} from '@app/platform/config/environment';
import {
  kafkaClientOptions,
  kafkaConsumerOptions,
} from '@app/platform/kafka/kafka.options';
import {
  ORDER_EVENT_PATTERN,
  ORDER_KAFKA_TRANSPORT,
} from '@app/platform/kafka/kafka.topics';
import { TopicKafkaServer } from '@app/platform/kafka/topic-kafka.server';
import { AppLogger } from '@app/platform/logging/app-logger';
import { CorrelationMiddleware } from '@app/platform/logging/correlation.middleware';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { Metrics } from '@app/platform/observability/metrics';
import { ObservabilityModule } from '@app/platform/observability/observability.module';
import {
  RequestAuditInterceptor,
  RequestAuditRepository,
} from '@app/platform/observability/request-audit';
import { ProductEntity } from '@app/products/domain/entities';
import { StockEntity } from '@app/products/inventory/domain/entities';
import { ProductsModule } from '@app/products/products.module';
import {
  configureApi,
  createOpenApiDocument,
} from '../../../apps/http/src/configure-api';
import { newProduct, ProductRecord } from './in-memory-store';

const execFileAsync = promisify(execFile);

type Cleanup = () => Promise<unknown>;

type SimulatorSettings = Partial<
  Pick<
    Environment,
    | 'ERP_FAILURES'
    | 'EMAIL_FAILURES'
    | 'SIMULATOR_DELAY_MS'
    | 'SIMULATOR_TIMEOUT_MS'
    | 'SIMULATOR_PERMANENT_FAILURE'
  >
>;

export async function seedProduct(
  dataSource: DataSource,
  product: ProductRecord = newProduct(),
): Promise<ProductRecord> {
  const { physicalQuantity, reservedQuantity, ...details } = product;

  await dataSource.getRepository(ProductEntity).insert(details);

  await dataSource.getRepository(StockEntity).insert({
    productId: product.id,
    physicalQuantity,
    reservedQuantity,
  });

  return product;
}

export async function waitUntil(
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const waitDeadlineMs = Date.now() + 15_000;

  while (!(await condition())) {

    if (Date.now() >= waitDeadlineMs) {

      throw new Error(`Timed out waiting for ${description}`);

    }

    await delay(25);

  }
}

function testEnvironment() {
  const environmentVariables = {
    ...parse(readFileSync('.env.test.example')),
    ...(existsSync('.env.test.local')
      ? parse(readFileSync('.env.test.local'))
      : {}),
  };

  for (const environmentVariable of [
    'DATABASE_URL',
    'KAFKA_BROKERS',
  ] as const) {

    if (process.env[environmentVariable]) {

      environmentVariables[environmentVariable] =
        process.env[environmentVariable];

    }

  }

  const databaseUrl = new URL(environmentVariables.DATABASE_URL ?? '');
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

  if (
    !localHosts.has(databaseUrl.hostname) ||
    !databaseUrl.pathname.endsWith('_test')
  ) {

    throw new Error(
      'Integration tests require a local dedicated _test database',
    );

  }

  if (
    !(environmentVariables.KAFKA_BROKERS ?? '')
      .split(',')
      .every((broker) => localHosts.has(broker.trim().split(':')[0] ?? ''))
  ) {

    throw new Error('Integration tests require local Kafka brokers');

  }

  return environmentVariables;
}

export async function createRealServicesTestApp(
  simulatorSettings: SimulatorSettings = {},
) {
  const connectionCleanups: Cleanup[] = [];
  const resourceCleanups: Cleanup[] = [];

  const close = async () => {
    const cleanupErrors: unknown[] = [];

    for (const cleanup of [
      ...connectionCleanups.reverse(),
      ...resourceCleanups.reverse(),
    ]) {

      try {

        await cleanup();

      } catch (error) {

        cleanupErrors.push(error);

      }

    }

    connectionCleanups.length = 0;
    resourceCleanups.length = 0;

    if (cleanupErrors.length) {

      throw new AggregateError(
        cleanupErrors,
        'Integration test teardown failed',
      );

    }
  };

  try {

    const environmentVariables = testEnvironment();
    const testSuffix = randomUUID().replaceAll('-', '');
    const testSchema = `integration_${testSuffix}`;
    const checkoutTopic = `integration.${testSuffix}`;
    const consumerGroupId = `integration-${testSuffix}`;

    const adminDataSource = new DataSource({
      ...databaseOptions(environmentVariables.DATABASE_URL!),
      entities: [],
      migrations: [],
    });

    resourceCleanups.push(async () => {
      if (adminDataSource.isInitialized) {

        await adminDataSource.destroy();

      }
    });

    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE SCHEMA "${testSchema}"`);

    resourceCleanups.push(() =>
      adminDataSource.query(`DROP SCHEMA "${testSchema}" CASCADE`),
    );

    const redisContainerName = `integration-redis-${testSuffix}`;

    await execFileAsync('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      redisContainerName,
      '--publish',
      '127.0.0.1::6379',
      'redis:7.4.6-bookworm',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    ]);

    let isRedisRunning = true;

    const stopRedis = async () => {
      if (isRedisRunning) {

        await execFileAsync('docker', ['stop', redisContainerName]);
        isRedisRunning = false;

      }
    };

    resourceCleanups.push(stopRedis);

    const { stdout } = await execFileAsync('docker', [
      'port',
      redisContainerName,
      '6379/tcp',
    ]);

    const environmentSettings = validateEnvironment({
      ...environmentVariables,
      ERP_FAILURES: 0,
      EMAIL_FAILURES: 0,
      SIMULATOR_DELAY_MS: 20,
      SIMULATOR_TIMEOUT_MS: 1000,
      SIMULATOR_PERMANENT_FAILURE: 'none',
      RESERVATION_TTL_SECONDS: 900,
      ...simulatorSettings,
      NODE_ENV: 'test',
      REDIS_URL: `redis://${stdout.trim()}`,
      CHECKOUT_TOPIC: checkoutTopic,
      KAFKA_GROUP_ID: consumerGroupId,
    });

    const configService = new ConfigService(environmentSettings);
    const kafkaClient = new Kafka(kafkaClientOptions(configService));
    const kafkaAdmin = kafkaClient.admin();

    resourceCleanups.push(() => kafkaAdmin.disconnect());
    await kafkaAdmin.connect();
    const testTopics = [checkoutTopic, `${checkoutTopic}.dlq`];

    resourceCleanups.push(() =>
      kafkaAdmin.deleteTopics({ topics: testTopics }),
    );

    await kafkaAdmin.createTopics({
      waitForLeaders: true,
      topics: testTopics.map((topicName) => ({
        topic: topicName,
        numPartitions: 1,
        replicationFactor: 1,
      })),
    });

    const dataSourceOptions = {
      ...databaseOptions(environmentSettings.DATABASE_URL),
      schema: testSchema,
      extra: {
        statement_timeout: 3000,
        options: `-c search_path=${testSchema}`,
      },
    };

    const dataSource = new DataSource(dataSourceOptions);

    connectionCleanups.push(async () => {
      if (dataSource.isInitialized) {

        await dataSource.destroy();

      }
    });

    await dataSource.initialize();
    await dataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [() => environmentSettings],
        }),
        TypeOrmModule.forRootAsync({
          useFactory: () => dataSourceOptions,
          dataSourceFactory: async () => dataSource,
        }),
        // Tests drive real relay and scheduler cycles explicitly.
        ScheduleModule.forRoot({
          cronJobs: false,
          intervals: false,
          timeouts: false,
        }),
        OrderModule,
        ProductsModule,
        OrderSchedulerModule,
        OrderConsumerModule,
        LoggingModule,
        ObservabilityModule,
      ],
      providers: [
        RequestAuditRepository,
        { provide: APP_INTERCEPTOR, useClass: RequestAuditInterceptor },
      ],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication({
      logger: false,
    });

    connectionCleanups.push(() => app.close());
    const correlationMiddleware = new CorrelationMiddleware(app.get(AppLogger));

    app.use((request: never, response: never, next: () => void) =>
      correlationMiddleware.use(request, response, next),
    );

    configureApi(app);
    SwaggerModule.setup('api-docs', app, createOpenApiDocument(app));
    await app.init();
    const redisConnection = app.get(RedisConnection);

    await waitUntil(
      async () => redisConnection.redisClient.isReady,
      'isolated Redis readiness',
    );

    await redisConnection.redisClient.ping();

    const consumerGroupIds: string[] = [];

    resourceCleanups.push(async () => {
      if (consumerGroupIds.length) {

        await kafkaAdmin.deleteGroups(consumerGroupIds);

      }
    });

    return {
      app,
      dataSource,
      redisConnection,
      checkoutTopic,
      metricsService: app.get(Metrics),
      orderMessaging: app
        .select(OrderConsumerModule)
        .get(OrderMessaging, { strict: true }),
      outboxRelay: app.get(OutboxRelay),
      expireReservationsUseCase: app.get(ExpireReservationsUseCase),
      close,
      stopRedis,
      offsets: (observedTopic = checkoutTopic) =>
        kafkaAdmin.fetchTopicOffsets(observedTopic),
      async observe(observedTopic = checkoutTopic) {
        const observerGroupId = `${consumerGroupId}-observer-${randomUUID()}`;

        const observerConsumer = kafkaClient.consumer({
          groupId: observerGroupId,
        });

        connectionCleanups.push(() => observerConsumer.disconnect());
        const messages: { topic: string; message: KafkaMessage }[] = [];
        let hasObserverJoined = false;
        let observerError: Error | undefined;

        observerConsumer.on(observerConsumer.events.GROUP_JOIN, () => {
          hasObserverJoined = true;
        });

        observerConsumer.on(observerConsumer.events.CRASH, ({ payload }) => {
          observerError = payload.error;
        });

        await observerConsumer.connect();

        await observerConsumer.subscribe({
          topic: observedTopic,
          fromBeginning: true,
        });

        consumerGroupIds.push(observerGroupId);

        await observerConsumer.run({
          eachMessage: async ({ topic: receivedTopic, message }) => {
            messages.push({ topic: receivedTopic, message });
          },
        });

        await waitUntil(async () => {
          if (observerError) {

            throw observerError;

          }

          return hasObserverJoined;
        }, 'Kafka observer group join');

        return messages;
      },
      async waitForConsumerOffset(offset: number) {
        await waitUntil(async () => {
          const groupOffsets = await kafkaAdmin.fetchOffsets({
            groupId: consumerGroupId,
            topics: [checkoutTopic],
          });

          const committedOffset = groupOffsets[0]?.partitions[0]?.offset;

          return (
            committedOffset !== undefined && Number(committedOffset) >= offset
          );
        }, `consumer offset ${offset}`);
      },
      async startConsumer() {
        let isConsumerReady = false;

        const kafkaServer = new TopicKafkaServer(
          kafkaConsumerOptions(configService, consumerGroupId),
          ORDER_KAFKA_TRANSPORT,
          ORDER_EVENT_PATTERN,
          checkoutTopic,
          (isReady) => {
            isConsumerReady = isReady;
          },
        );

        // Drain Kafka handlers before Nest destroys their database/Redis providers.
        connectionCleanups.push(() => kafkaServer.close());

        app.useGlobalFilters(app.get(OrderConsumerExceptionFilter));

        app.connectMicroservice<MicroserviceOptions>(
          { strategy: kafkaServer },
          { inheritAppConfig: true },
        );

        await app.startAllMicroservices();
        consumerGroupIds.push(consumerGroupId);

        await waitUntil(
          async () => isConsumerReady,
          'order consumer group join',
        );
      },
    };

  } catch (error) {

    try {

      await close();

    } catch (cleanupError) {

      throw new AggregateError(
        [error, cleanupError],
        'Integration test setup and teardown failed',
        { cause: cleanupError },
      );

    }

    throw error;

  }
}

export type RealServicesTestApp = Awaited<
  ReturnType<typeof createRealServicesTestApp>
>;
