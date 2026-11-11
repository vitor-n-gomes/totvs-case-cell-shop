import { GetProducts } from '@app/shop/catalog/get-products';
import { ProductRepository } from '@app/shop/catalog/product.repository';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { AppLogger } from '@app/platform/logging/app-logger';

const logger = { info: jest.fn(), warn: jest.fn() } as unknown as AppLogger;
const product = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Case',
  productKey: 'case',
  netPrice: '10.00',
  listPrice: '12.00',
};
function setup() {
  const repository = {
    findAll: jest.fn().mockImplementation(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return [product];
    }),
  };
  const client = {
    isReady: true,
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
    withCommandOptions: () => client,
  };
  const metrics = new Metrics();
  const catalog = new GetProducts(
    repository as unknown as ProductRepository,
    { client } as unknown as RedisConnection,
    metrics,
    new Spans(logger),
    logger,
  );
  return { repository, client, metrics, catalog };
}
describe('Catalog cache policy', () => {
  it('serves valid cache hits without querying PostgreSQL', async () => {
    const { repository, client, catalog } = setup();
    client.get.mockResolvedValue(JSON.stringify([product]));
    expect(await catalog.execute()).toEqual([product]);
    expect(repository.findAll).not.toHaveBeenCalled();
  });
  it('coalesces concurrent misses and uses token-checked cache population', async () => {
    const { repository, client, catalog } = setup();
    await Promise.all(Array.from({ length: 20 }, () => catalog.execute()));
    expect(repository.findAll).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith(
      'storefront:products:lock',
      expect.any(String),
      { NX: true, PX: 5000 },
    );
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("'EX',300"),
      expect.objectContaining({
        arguments: [expect.any(String), JSON.stringify([product])],
      }),
    );
  });
  it('coalesces fallback reads during a Redis outage', async () => {
    const { repository, client, catalog } = setup();
    client.isReady = false;
    await Promise.all(Array.from({ length: 20 }, () => catalog.execute()));
    expect(repository.findAll).toHaveBeenCalledTimes(1);
  });
  it('recovers after a failed loader and releases the lock', async () => {
    const { repository, client, catalog } = setup();
    repository.findAll.mockRejectedValueOnce(new Error('database offline'));
    await expect(catalog.execute()).rejects.toThrow(
      'Catalog temporarily unavailable',
    );
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("'del'"),
      expect.anything(),
    );
    await expect(catalog.execute()).resolves.toEqual([product]);
  });
  it('bounds waiting behind a live owner without loading the database', async () => {
    jest.useFakeTimers();
    try {
      const { client, catalog, repository } = setup();
      client.set.mockResolvedValue(null);
      const outcome = expect(catalog.execute()).rejects.toThrow(
        'Catalog refresh in progress',
      );
      await jest.advanceTimersByTimeAsync(6100);
      await outcome;
      expect(repository.findAll).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
  it('replaces malformed cached data', async () => {
    const { client, catalog } = setup();
    client.get.mockResolvedValue('{bad json');
    await expect(catalog.execute()).resolves.toEqual([product]);
  });
});
