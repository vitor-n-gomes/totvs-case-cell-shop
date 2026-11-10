import { RedisConnection } from '@app/platform/cache/redis-connection';
import { AppLogger } from '@app/platform/logging/app-logger';
import {
  RedisReceiptCache,
  receiptCacheKey,
} from '@app/demo/adapters/redis-receipt.cache';
import { receipt } from './fixtures';

describe('Redis receipt cache', () => {
  const commands = { get: jest.fn(), set: jest.fn() };
  const client = { isReady: true, withCommandOptions: jest.fn(() => commands) };
  const logger = { info: jest.fn() };
  const cache = new RedisReceiptCache(
    { client } as unknown as RedisConnection,
    logger as unknown as AppLogger,
  );
  beforeEach(() => {
    jest.clearAllMocks();
    client.isReady = true;
  });

  it('uses a 30-second TTL for immutable receipts', async () => {
    const saved = receipt();
    await cache.set(saved);
    expect(commands.set).toHaveBeenCalledWith(
      receiptCacheKey(saved.eventId),
      JSON.stringify(saved),
      { EX: 30 },
    );
  });
  it('decodes a cached receipt', async () => {
    const saved = receipt();
    commands.get.mockResolvedValue(JSON.stringify(saved));
    await expect(cache.get(saved.eventId)).resolves.toEqual(saved);
  });
  it('treats corrupted cache values as misses', async () => {
    commands.get.mockResolvedValue('not JSON');
    await expect(cache.get(receipt().eventId)).resolves.toBeNull();
  });
  it('rejects cached data with the wrong event ID', async () => {
    commands.get.mockResolvedValue(JSON.stringify(receipt()));
    await expect(cache.get(receipt().eventId)).resolves.toBeNull();
  });
  it('falls back immediately while disconnected', async () => {
    client.isReady = false;
    await expect(cache.get(receipt().eventId)).resolves.toBeNull();
    await expect(cache.set(receipt())).resolves.toBeUndefined();
    expect(client.withCommandOptions).not.toHaveBeenCalled();
  });
  it('does not let Redis command failures break reads or writes', async () => {
    commands.get.mockRejectedValue(new Error('Redis down'));
    commands.set.mockRejectedValue(new Error('Redis down'));
    await expect(cache.get(receipt().eventId)).resolves.toBeNull();
    await expect(cache.set(receipt())).resolves.toBeUndefined();
  });
});
