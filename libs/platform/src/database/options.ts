import { orderEntities } from '@app/order/domain/entities';
import { RequestLogEntity } from './request-log.entity';
import { shopEntities } from '@app/shop/entities';
import { CreateShop1730000001000 } from './migrations/1730000001000-create-shop';
import { DataSourceOptions } from 'typeorm';

export function databaseOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [
      RequestLogEntity,
      ...shopEntities,
      ...orderEntities,
    ],
    migrations: [CreateShop1730000001000],
    synchronize: false,
    migrationsRun: false,
    connectTimeoutMS: 3000,
    extra: { statement_timeout: 3000 },
  };
}
