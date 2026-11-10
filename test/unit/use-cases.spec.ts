import { PublishMessage } from '@app/demo/use-cases/publish-message';
import { ReceiveMessage } from '@app/demo/use-cases/receive-message';
import { GetReceipt } from '@app/demo/use-cases/get-receipt';
import { event, receipt } from './fixtures';

describe('Demo use cases', () => {
  const publisher = { publish: jest.fn() };
  const repository = { saveOnce: jest.fn(), findById: jest.fn() };
  const cache = { get: jest.fn(), set: jest.fn() };
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('does not report publication before the broker acknowledges it', async () => {
    let acknowledge!: () => void;
    publisher.publish.mockReturnValue(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const input = event();
    let completed = false;
    const result = new PublishMessage(publisher)
      .execute(input.message, input.correlationId)
      .then((value) => {
        completed = true;
        return value;
      });
    await Promise.resolve();
    expect(completed).toBe(false);
    acknowledge();
    const response = await result;
    expect(response.status).toBe('published');
    expect(publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: response.eventId,
        message: input.message,
        correlationId: input.correlationId,
        schemaVersion: 1,
      }),
    );
  });

  it('propagates publication failures', async () => {
    publisher.publish.mockRejectedValue(new Error('broker unavailable'));
    await expect(
      new PublishMessage(publisher).execute('hello', event().correlationId),
    ).rejects.toThrow('broker unavailable');
  });

  it('validates events before attempting persistence', async () => {
    await expect(
      new ReceiveMessage(repository).execute({ ...event(), message: ' ' }),
    ).rejects.toThrow();
    expect(repository.saveOnce).not.toHaveBeenCalled();
  });

  it('awaits persistence and propagates failure for redelivery', async () => {
    const input = event();
    repository.saveOnce.mockRejectedValue(new Error('database unavailable'));
    await expect(new ReceiveMessage(repository).execute(input)).rejects.toThrow(
      'database unavailable',
    );
    expect(repository.saveOnce).toHaveBeenCalledWith(input);
  });

  it('returns cache hits without querying PostgreSQL', async () => {
    const saved = receipt();
    cache.get.mockResolvedValue(saved);
    await expect(
      new GetReceipt(repository, cache).execute(saved.eventId),
    ).resolves.toEqual(saved);
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it('fills the cache after a database lookup', async () => {
    const saved = receipt();
    cache.get.mockResolvedValue(null);
    repository.findById.mockResolvedValue(saved);
    await expect(
      new GetReceipt(repository, cache).execute(saved.eventId),
    ).resolves.toEqual(saved);
    expect(cache.set).toHaveBeenCalledWith(saved);
  });

  it('does not cache absent receipts', async () => {
    cache.get.mockResolvedValue(null);
    repository.findById.mockResolvedValue(null);
    await expect(
      new GetReceipt(repository, cache).execute(event().eventId),
    ).resolves.toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });
});
