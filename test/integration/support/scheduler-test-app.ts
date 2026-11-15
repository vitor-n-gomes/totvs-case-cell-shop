// Load database metadata before repositories: the entity barrels are cyclic.
import { databaseOptions } from '@app/platform/database/options';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MicroserviceOptions } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { parse } from 'dotenv';
import { Kafka, KafkaMessage } from 'kafkajs';
import { DataSource } from 'typeorm';
import { OrderModule } from '@app/order/order.module';
import { OrderConsumerModule } from '@app/order/order-consumer.module';
import { OrderSchedulerModule } from '@app/order/order-scheduler.module';
import { ExpireReservationsUseCase } from '@app/order/adapters/usecases/expire-reservations.use-case';
import { OutboxRelay } from '@app/order/messaging/outbox-relay';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { validateEnvironment } from '@app/platform/config/environment';
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
import { Metrics } from '@app/platform/observability/metrics';
import { ProductsModule } from '@app/products/products.module';
import { configureApi } from '../../../apps/http/src/configure-api';

const exec = promisify(execFile);
type Cleanup = () => Promise<unknown>;

export async function waitUntil(
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
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
    if (process.env[key]) values[key] = process.env[key];
  }
  const database = new URL(values.DATABASE_URL ?? '');
  if (!database.pathname.endsWith('_test'))
    throw new Error(
      'Scheduler integration requires a dedicated _test database',
    );
  return values;
}

export async function createSchedulerTestApp() {
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
    if (errors.length)
      throw new AggregateError(errors, 'Scheduler test teardown failed');
  };

  try {
    const values = testEnvironment();
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `scheduler_${suffix}`;
    const topic = `scheduler.${suffix}`;
    const group = `scheduler-${suffix}`;
    const adminDatabase = new DataSource({
      ...databaseOptions(values.DATABASE_URL!),
      entities: [],
      migrations: [],
    });
    resources.push(async () => {
      if (adminDatabase.isInitialized) await adminDatabase.destroy();
    });
    await adminDatabase.initialize();
    await adminDatabase.query(`CREATE SCHEMA "${schema}"`);
    resources.push(() =>
      adminDatabase.query(`DROP SCHEMA "${schema}" CASCADE`),
    );

    const container = `scheduler-test-${suffix}`;
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
    resources.push(() => exec('docker', ['stop', container]));
    const { stdout } = await exec('docker', ['port', container, '6379/tcp']);
    const settings = validateEnvironment({
      ...values,
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
      if (database.isInitialized) await database.destroy();
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
        ScheduleModule.forRoot(),
        OrderModule,
        ProductsModule,
        OrderSchedulerModule,
        OrderConsumerModule,
      ],
    })
      // Checkout creates its outbox row, but activation is not part of this flow.
      .overrideProvider(OutboxRelay)
      .useValue({})
      .compile();
    const app: INestApplication = moduleRef.createNestApplication({
      logger: false,
    });
    connections.push(() => app.close());
    const correlation = new CorrelationMiddleware(app.get(AppLogger));
    app.use((req: never, res: never, next: () => void) =>
      correlation.use(req, res, next),
    );
    configureApi(app);
    await app.init();
    const redis = app.get(RedisConnection);
    await waitUntil(
      async () => redis.client.isReady,
      'isolated Redis readiness',
    );
    await redis.client.ping();

    const groups: string[] = [];
    resources.push(async () => {
      if (groups.length) await admin.deleteGroups(groups);
    });

    return {
      app,
      database,
      redis,
      topic,
      metrics: app.get(Metrics),
      scheduler: app.get(ExpireReservationsUseCase),
      close,
      offsets: () => admin.fetchTopicOffsets(topic),
      async observe() {
        const observerGroup = `${group}-observer`;
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
        await observer.subscribe({ topic, fromBeginning: true });
        groups.push(observerGroup);
        await observer.run({
          eachMessage: async ({ topic: receivedTopic, message }) => {
            messages.push({ topic: receivedTopic, message });
          },
        });
        await waitUntil(async () => {
          if (failure) throw failure;
          return joined;
        }, 'Kafka observer group join');
        return messages;
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
        'Scheduler test setup and teardown failed',
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export type SchedulerTestApp = Awaited<
  ReturnType<typeof createSchedulerTestApp>
>;
