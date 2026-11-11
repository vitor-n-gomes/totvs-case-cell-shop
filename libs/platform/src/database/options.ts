import { shopEntities } from '@app/shop/entities';
import { CreateShop1730000001000 } from './migrations/1730000001000-create-shop';
import { DataSourceOptions } from 'typeorm';
import { MessageReceiptEntity } from './receipt.entity';
import { CreateMessageReceipts1730000000000 } from './migrations/1730000000000-create-message-receipts';

export function databaseOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [MessageReceiptEntity, ...shopEntities],
    migrations: [CreateMessageReceipts1730000000000, CreateShop1730000001000],
    synchronize: false,
    migrationsRun: false,
    connectTimeoutMS: 3000,
    extra: { statement_timeout: 3000 },
  };
}
