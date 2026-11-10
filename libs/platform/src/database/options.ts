import { DataSourceOptions } from 'typeorm';
import { MessageReceiptEntity } from './receipt.entity';
import { CreateMessageReceipts1730000000000 } from './migrations/1730000000000-create-message-receipts';

export function databaseOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [MessageReceiptEntity],
    migrations: [CreateMessageReceipts1730000000000],
    synchronize: false,
    migrationsRun: false,
    connectTimeoutMS: 3000,
    extra: { statement_timeout: 3000 },
  };
}
