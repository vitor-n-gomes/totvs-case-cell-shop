import { Module } from '@nestjs/common';
import { CacheModule } from '@app/platform/cache/cache.module';
import { LoggingModule } from '@app/platform/logging/logging.module';
import { KafkaModule } from '@app/platform/kafka/kafka.module';
import { DemoPersistenceModule } from './demo-persistence.module';
import { ReceiptCache } from './ports/receipt-cache';
import { MessagePublisher } from './ports/message-publisher';
import { RedisReceiptCache } from './adapters/redis-receipt.cache';
import { KafkaMessagePublisher } from './adapters/kafka-message.publisher';
import { GetReceipt } from './use-cases/get-receipt';
import { PublishMessage } from './use-cases/publish-message';

@Module({
  imports: [DemoPersistenceModule, CacheModule, KafkaModule, LoggingModule],
  providers: [
    GetReceipt,
    PublishMessage,
    { provide: ReceiptCache, useClass: RedisReceiptCache },
    { provide: MessagePublisher, useClass: KafkaMessagePublisher },
  ],
  exports: [GetReceipt, PublishMessage],
})
export class DemoApiModule {}
