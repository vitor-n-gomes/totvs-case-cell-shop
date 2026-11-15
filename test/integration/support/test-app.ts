import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { OrderController } from '@app/order/adapters/http/order.controller';
import { CheckoutUseCase } from '@app/order/adapters/usecases/checkout.use-case';
import { CheckoutGuard } from '@app/order/adapters/usecases/guards/checkout.guard';
import { GetOrderStatusUseCase } from '@app/order/adapters/usecases/get-order-status.use-case';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { OutboxRepository } from '@app/order/repositories/outbox.repository';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { AppLogger } from '@app/platform/logging/app-logger';
import { CorrelationMiddleware } from '@app/platform/logging/correlation.middleware';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { ProductsController } from '@app/products/adapters/http/products.controller';
import { GetProductsUseCase } from '@app/products/adapters/usecases/get-products.use-case';
import { StockRepository } from '@app/products/inventory/repositories/stock.repository';
import { ProductRepository } from '@app/products/repositories/product.repository';
import { configureApi } from '../../../apps/http/src/configure-api';
import { InMemoryRedisConnection } from './in-memory-redis';
import {
  FakeDataSource,
  FakeOrderRepository,
  FakeOutboxRepository,
  FakeProductRepository,
  FakeStockRepository,
  InMemoryStore,
} from './in-memory-store';

export const CHECKOUT_TOPIC = 'order.checkout.initiated';

export interface TestApp {
  app: INestApplication;
  store: InMemoryStore;
  redis: InMemoryRedisConnection;
  metrics: Metrics;
}

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
  setApp: () => undefined,
};

const settings: Record<string, unknown> = {
  RESERVATION_TTL_SECONDS: 900,
  CHECKOUT_TOPIC,
};

/**
 * Boots the real controllers, use cases, correlation middleware, validation pipe
 * and exception filter of the HTTP app. Only PostgreSQL and Redis are replaced
 * by in-memory fakes; Kafka is never touched by the HTTP side.
 * TODO: swap the fake providers for the real HttpModule once test containers exist.
 */
export async function createTestApp(): Promise<TestApp> {
  const store = new InMemoryStore();
  const redis = new InMemoryRedisConnection();
  const moduleRef = await Test.createTestingModule({
    controllers: [ProductsController, OrderController],
    providers: [
      GetProductsUseCase,
      CheckoutUseCase,
      CheckoutGuard,
      GetOrderStatusUseCase,
      Metrics,
      Spans,
      { provide: AppLogger, useValue: silentLogger },
      {
        provide: ConfigService,
        useValue: { getOrThrow: (key: string) => settings[key] },
      },
      { provide: RedisConnection, useValue: redis },
      { provide: DataSource, useValue: new FakeDataSource() },
      {
        provide: ProductRepository,
        useValue: new FakeProductRepository(store),
      },
      { provide: OrderRepository, useValue: new FakeOrderRepository(store) },
      { provide: StockRepository, useValue: new FakeStockRepository(store) },
      { provide: OutboxRepository, useValue: new FakeOutboxRepository(store) },
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  const correlation = new CorrelationMiddleware(app.get(AppLogger));
  app.use((req: never, res: never, next: () => void) =>
    correlation.use(req, res, next),
  );
  configureApi(app);
  await app.init();
  return { app, store, redis, metrics: app.get(Metrics) };
}
