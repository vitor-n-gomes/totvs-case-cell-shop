import { ConfigService } from '@nestjs/config';
import { EachMessageHandler, EachMessagePayload } from 'kafkajs';
import { DemoConsumer } from '../../apps/worker/src/demo/demo.consumer';
import { ReceiveMessage } from '@app/demo/use-cases/receive-message';
import { KafkaConnection } from '@app/platform/messaging/kafka-connection';
import { HealthService } from '@app/platform/health/health.service';
import { AppLogger } from '@app/platform/logging/app-logger';
import { event } from './fixtures';

describe('Kafka processing completion', () => {
  let handler: EachMessageHandler;
  const transport = {
    on: jest.fn(),
    connect: jest.fn(),
    subscribe: jest.fn(),
    stop: jest.fn(),
    disconnect: jest.fn(),
    events: {
      GROUP_JOIN: 'join',
      CRASH: 'crash',
      DISCONNECT: 'disconnect',
      STOP: 'stop',
    },
    run: jest.fn(async (options: { eachMessage: EachMessageHandler }) => {
      handler = options.eachMessage;
    }),
  };
  const receive = { execute: jest.fn() };
  const logger = { info: jest.fn(), error: jest.fn() };
  const payload = (body: unknown) =>
    ({
      message: { value: Buffer.from(JSON.stringify(body)) },
    }) as EachMessagePayload;

  beforeEach(async () => {
    jest.clearAllMocks();
    receive.execute.mockReset();
    const consumer = new DemoConsumer(
      { kafka: { consumer: () => transport } } as unknown as KafkaConnection,
      new ConfigService({
        KAFKA_TOPIC: 'test-topic',
        KAFKA_GROUP_ID: 'test-group',
      }),
      receive as unknown as ReceiveMessage,
      logger as unknown as AppLogger,
      { consumerReady: false } as HealthService,
    );
    await consumer.onApplicationBootstrap();
  });
  it('keeps the handler pending until persistence succeeds', async () => {
    let persist!: () => void;
    receive.execute.mockReturnValue(
      new Promise<void>((resolve) => {
        persist = resolve;
      }),
    );
    let completed = false;
    const result = handler(payload(event())).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    persist();
    await result;
    expect(completed).toBe(true);
  });
  it('rejects the handler when persistence fails', async () => {
    receive.execute.mockRejectedValue(new Error('database unavailable'));
    await expect(handler(payload(event()))).rejects.toThrow(
      'Message processing failed',
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      'demo.message.received',
      expect.anything(),
    );
  });
  it('rejects invalid events before persistence', async () => {
    await expect(handler(payload({ invalid: true }))).rejects.toThrow(
      'Message processing failed',
    );
    expect(receive.execute).not.toHaveBeenCalled();
  });
});
