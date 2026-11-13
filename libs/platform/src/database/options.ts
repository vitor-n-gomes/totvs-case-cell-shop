import { orderEntities } from '@app/order/domain/entities';
import { RequestLogEntity } from './request-log.entity';
import { shopEntities } from '@app/shop/entities';
import { CreateOrder1794700000001 } from './migrations/1794700000001-create-order';
import { CreateProduct1794700000002 } from './migrations/1794700000002-create-product';
import { CreateStock1794700000003 } from './migrations/1794700000003-create-stock';
import { CreateOrderItem1794700000004 } from './migrations/1794700000004-create-order-item';
import { CreateStockReservation1794700000005 } from './migrations/1794700000005-create-stock-reservation';
import { CreateIdempotencyLog1794700000006 } from './migrations/1794700000006-create-idempotency-log';
import { CreateOutboxEvents1794700000007 } from './migrations/1794700000007-create-outbox-events';
import { CreateRequestLog1794700000008 } from './migrations/1794700000008-create-request-log';
import { AddUpdatedAtToEntities1794700000009 } from './migrations/1794700000009-add-updated-at-to-entities';
import { DataSourceOptions } from 'typeorm';

const migrations = [
  CreateOrder1794700000001,
  CreateProduct1794700000002,
  CreateStock1794700000003,
  CreateOrderItem1794700000004,
  CreateStockReservation1794700000005,
  CreateIdempotencyLog1794700000006,
  CreateOutboxEvents1794700000007,
  CreateRequestLog1794700000008,
  AddUpdatedAtToEntities1794700000009,
];

export function databaseOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [RequestLogEntity, ...shopEntities, ...orderEntities],
    migrations,
    synchronize: false,
    migrationsRun: false,
    connectTimeoutMS: 3000,
    extra: { statement_timeout: 3000 },
  };
}
