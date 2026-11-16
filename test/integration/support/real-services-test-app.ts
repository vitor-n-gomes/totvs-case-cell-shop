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

const exec = promisify(execFile);

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
  database: DataSource,
  product: ProductRecord = newProduct(),
): Promise<ProductRecord> {
  const { physicalQuantity, reservedQuantity, ...details } = product;

  await database.getRepository(ProductEntity).insert(details);

  await database.getRepository(StockEntity).insert({
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
  const deadline = Date.now() + 15_000;

  while (!(await condition())) {

    if (Date.now() >= deadline) {

      throw new Error(`Timed out waiting for ${description}`);

    }

    await delay(25);

  }
}

function testEnvironment() {
  const values = {
    ...parse(readFileSync('.env.test.example')),
    ...(existsSync('.env.test.local')
      ? parse(readFileSync('.env.test.local'))
      : {}),
  };

  for (const key of ['DATABASE_URL', 'KAFKA_BROKERS'] as const) {

    if (process.env[key]) {

      values[key] = process.env[key];

    }

  }

  const database = new URL(values.DATABASE_URL ?? '');
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

  if (
    !localHosts.has(database.hostname) ||
    !database.pathname.endsWith('_test')
  ) {

    throw new Error(
      'Integration tests require a local dedicated _test database',
    );

  }

  if (
    !(values.KAFKA_BROKERS ?? '')
      .split(',')
      .every((broker) => localHosts.has(broker.trim().split(':')[0] ?? ''))
  ) {

    throw new Error('Integration tests require local Kafka brokers');

  }

  return values;
}

export async function createRealServicesTestApp(
  simulator: SimulatorSettings = {},
) {
  const connections: Cleanup[] = [];
  const resources: Cleanup[] = [];

  const close = async () => {
    const errors: unknown[] = [];

    for (const cleanup of [...connections.reverse(), ...resources.reverse()]) {

      try {

        await cleanup();

      } catch (error) {

        errors.push(error);

      }

    }

    connections.length = 0;
    resources.length = 0;

    if (errors.length) {

      throw new AggregateError(errors, 'Integration test teardown failed');

    }
  };

  try {

    const values = testEnvironment();
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `integration_${suffix}`;
    const topic = `integration.${suffix}`;
    const group = `integration-${suffix}`;

    const adminDatabase = new DataSource({
      ...databaseOptions(values.DATABASE_URL!),
      entities: [],
      migrations: [],
    });

    resources.push(async () => {
      if (adminDatabase.isInitialized) {

        await adminDatabase.destroy();

      }
    });

    await adminDatabase.initialize();
    await adminDatabase.query(`CREATE SCHEMA "${schema}"`);

    resources.push(() =>
      adminDatabase.query(`DROP SCHEMA "${schema}" CASCADE`),
    );

    const container = `integration-redis-${suffix}`;

    await exec('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--publish',
      '127.0.0.1::6379',
      'redis:7.4.6-bookworm',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    ]);

    let redisRunning = true;

    const stopRedis = async () => {
      if (redisRunning) {

        await exec('docker', ['stop', container]);
        redisRunning = false;

      }
    };

    resources.push(stopRedis);
    const { stdout } = await exec('docker', ['port', container, '6379/tcp']);

    const settings = validateEnvironment({
      ...values,
      ERP_FAILURES: 0,
      EMAIL_FAILURES: 0,
      SIMULATOR_DELAY_MS: 20,
      SIMULATOR_TIMEOUT_MS: 1000,
      SIMULATOR_PERMANENT_FAILURE: 'none',
      RESERVATION_TTL_SECONDS: 900,
      ...simulator,
      NODE_ENV: 'test',
      REDIS_URL: `redis://${stdout.trim()}`,
      CHECKOUT_TOPIC: topic,
      KAFKA_GROUP_ID: group,
    });

    const config = new ConfigService(settings);
    const kafka = new Kafka(kafkaClientOptions(config));
    const admin = kafka.admin();

    resources.push(() => admin.disconnect());
    await admin.connect();
    const topics = [topic, `${topic}.dlq`];

    resources.push(() => admin.deleteTopics({ topics }));

    await admin.createTopics({
      waitForLeaders: true,
      topics: topics.map((name) => ({
        topic: name,
        numPartitions: 1,
        replicationFactor: 1,
      })),
    });

    const options = {
      ...databaseOptions(settings.DATABASE_URL),
      schema,
      extra: {
        statement_timeout: 3000,
        options: `-c search_path=${schema}`,
      },
    };

    const database = new DataSource(options);

    connections.push(async () => {
      if (database.isInitialized) {

        await database.destroy();

      }
    });

    await database.initialize();
    await database.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [() => settings],
        }),
        TypeOrmModule.forRootAsync({
          useFactory: () => options,
          dataSourceFactory: async () => database,
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

    connections.push(() => app.close());
    const correlation = new CorrelationMiddleware(app.get(AppLogger));

    app.use((req: never, res: never, next: () => void) =>
      correlation.use(req, res, next),
    );

    configureApi(app);
    SwaggerModule.setup('api-docs', app, createOpenApiDocument(app));
    await app.init();
    const redis = app.get(RedisConnection);

    await waitUntil(
      async () => redis.client.isReady,
      'isolated Redis readiness',
    );

    await redis.client.ping();

    const groups: string[] = [];

    resources.push(async () => {
      if (groups.length) {

        await admin.deleteGroups(groups);

      }
    });

    return {
      app,
      database,
      redis,
      topic,
      metrics: app.get(Metrics),
      messaging: app
        .select(OrderConsumerModule)
        .get(OrderMessaging, { strict: true }),
      relay: app.get(OutboxRelay),
      scheduler: app.get(ExpireReservationsUseCase),
      close,
      stopRedis,
      offsets: (observedTopic = topic) =>
        admin.fetchTopicOffsets(observedTopic),
      async observe(observedTopic = topic) {
        const observerGroup = `${group}-observer-${randomUUID()}`;
        const observer = kafka.consumer({ groupId: observerGroup });

        connections.push(() => observer.disconnect());
        const messages: { topic: string; message: KafkaMessage }[] = [];
        let joined = false;
        let failure: Error | undefined;

        observer.on(observer.events.GROUP_JOIN, () => {
          joined = true;
        });

        observer.on(observer.events.CRASH, ({ payload }) => {
          failure = payload.error;
        });

        await observer.connect();
        await observer.subscribe({ topic: observedTopic, fromBeginning: true });
        groups.push(observerGroup);

        await observer.run({
          eachMessage: async ({ topic: receivedTopic, message }) => {
            messages.push({ topic: receivedTopic, message });
          },
        });

        await waitUntil(async () => {
          if (failure) {

            throw failure;

          }

          return joined;
        }, 'Kafka observer group join');

        return messages;
      },
      async waitForConsumerOffset(offset: number) {
        await waitUntil(async () => {
          const offsets = await admin.fetchOffsets({
            groupId: group,
            topics: [topic],
          });

          const committed = offsets[0]?.partitions[0]?.offset;

          return committed !== undefined && Number(committed) >= offset;
        }, `consumer offset ${offset}`);
      },
      async startConsumer() {
        let ready = false;

        const server = new TopicKafkaServer(
          kafkaConsumerOptions(config, group),
          ORDER_KAFKA_TRANSPORT,
          ORDER_EVENT_PATTERN,
          topic,
          (value) => {
            ready = value;
          },
        );

        // Drain Kafka handlers before Nest destroys their database/Redis providers.
        connections.push(() => server.close());

        app.connectMicroservice<MicroserviceOptions>({
          strategy: server,
        });

        await app.startAllMicroservices();
        groups.push(group);
        await waitUntil(async () => ready, 'order consumer group join');
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
