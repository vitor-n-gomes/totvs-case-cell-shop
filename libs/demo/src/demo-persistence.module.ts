import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageReceiptEntity } from '@app/platform/database/receipt.entity';
import { ReceiptRepository } from './ports/receipt-repository';
import { PostgresReceiptRepository } from './adapters/postgres-receipt.repository';

@Module({
  imports: [TypeOrmModule.forFeature([MessageReceiptEntity])],
  providers: [
    { provide: ReceiptRepository, useClass: PostgresReceiptRepository },
  ],
  exports: [ReceiptRepository],
})
export class DemoPersistenceModule {}
