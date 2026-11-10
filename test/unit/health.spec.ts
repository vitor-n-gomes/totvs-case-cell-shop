import { DataSource } from 'typeorm';
import { HealthService } from '@app/platform/health/health.service';
import { KafkaConnection } from '@app/platform/messaging/kafka-connection';
import { RedisConnection } from '@app/platform/cache/redis-connection';

describe('Readiness', () => {
  const database = { query: jest.fn() };
  const kafka = { checkTopic: jest.fn() };
  const redis = { client: { isReady: false } };
  let health: HealthService;
  beforeEach(() => {
    jest.resetAllMocks();
    health = new HealthService(
      database as unknown as DataSource,
      kafka as unknown as KafkaConnection,
      redis as unknown as RedisConnection,
    );
  });
  it('does not require the optional cache to be ready', async () => {
    expect((await health.readiness()).ready).toBe(true);
    expect(await health.cacheStatus()).toEqual({
      redis: 'down',
      required: false,
    });
  });
  it('fails when PostgreSQL is unavailable', async () => {
    database.query.mockRejectedValue(new Error('down'));
    expect(await health.readiness()).toMatchObject({
      ready: false,
      checks: { postgres: 'down' },
    });
  });
  it('fails when Kafka is unavailable', async () => {
    kafka.checkTopic.mockRejectedValue(new Error('down'));
    expect(await health.readiness()).toMatchObject({
      ready: false,
      checks: { kafka: 'down' },
    });
  });
  it('requires the worker consumer to join its group', async () => {
    health.consumerReady = false;
    expect((await health.readiness()).ready).toBe(false);
  });
  it('becomes unready during shutdown', async () => {
    health.beforeApplicationShutdown();
    expect((await health.readiness()).ready).toBe(false);
  });
});
