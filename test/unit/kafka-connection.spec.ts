import { ConfigService } from '@nestjs/config';
import { KafkaConnection } from '@app/platform/messaging/kafka-connection';
import { AppLogger } from '@app/platform/logging/app-logger';

function setup() {
  const logger = { warn: jest.fn(), error: jest.fn() };
  const connection = new KafkaConnection(
    new ConfigService({
      KAFKA_BROKERS: ['localhost:9092'],
      KAFKA_TOPIC: 'demo',
      CHECKOUT_TOPIC: 'checkout',
    }),
    logger as unknown as AppLogger,
  );
  const producerConnect = jest
    .spyOn(connection.producer, 'connect')
    .mockResolvedValue();
  const adminConnect = jest
    .spyOn(connection.admin, 'connect')
    .mockResolvedValue();
  const producerDisconnect = jest
    .spyOn(connection.producer, 'disconnect')
    .mockResolvedValue();
  const adminDisconnect = jest
    .spyOn(connection.admin, 'disconnect')
    .mockResolvedValue();
  return {
    connection,
    logger,
    producerConnect,
    adminConnect,
    producerDisconnect,
    adminDisconnect,
  };
}

describe('Kafka connection lifecycle', () => {
  it('shares connection initialization across concurrent callers', async () => {
    const { connection, producerConnect, adminConnect } = setup();
    await Promise.all(
      Array.from({ length: 20 }, () => connection.ensureConnected()),
    );
    expect(producerConnect).toHaveBeenCalledTimes(1);
    expect(adminConnect).toHaveBeenCalledTimes(1);
    await connection.onApplicationShutdown();
  });

  it('allows a later attempt after a connection failure', async () => {
    const { connection, producerConnect } = setup();
    producerConnect.mockRejectedValueOnce(new Error('Broker unavailable'));
    await expect(connection.ensureConnected()).rejects.toThrow(
      'Broker unavailable',
    );
    await expect(connection.ensureConnected()).resolves.toBeUndefined();
    expect(producerConnect).toHaveBeenCalledTimes(2);
    await connection.onApplicationShutdown();
  });

  it('does not block module startup on an unavailable broker', async () => {
    const { connection, producerConnect, logger } = setup();
    producerConnect.mockRejectedValue(new Error('Broker unavailable'));
    expect(connection.onModuleInit()).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith('kafka.connection.unavailable');
    await connection.onApplicationShutdown();
  });

  it('checks all required topics after connection and closes both clients', async () => {
    const { connection, producerDisconnect, adminDisconnect } = setup();
    const metadata = jest
      .spyOn(connection.admin, 'fetchTopicMetadata')
      .mockResolvedValue({ topics: [] });
    await connection.checkTopic();
    expect(metadata).toHaveBeenCalledWith({
      topics: ['demo', 'checkout', 'checkout.dlq'],
    });
    await connection.onApplicationShutdown();
    expect(producerDisconnect).toHaveBeenCalledTimes(1);
    expect(adminDisconnect).toHaveBeenCalledTimes(1);
    await expect(connection.ensureConnected()).rejects.toThrow(
      'Kafka shutting down',
    );
  });
});
