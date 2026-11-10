import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageCreated, MessageReceipt } from '@app/contracts';
import { MessageReceiptEntity } from '@app/platform/database/receipt.entity';
import { ReceiptRepository } from '../ports/receipt-repository';

@Injectable()
export class PostgresReceiptRepository extends ReceiptRepository {
  constructor(
    @InjectRepository(MessageReceiptEntity)
    private readonly repository: Repository<MessageReceiptEntity>,
  ) {
    super();
  }

  async saveOnce(event: MessageCreated): Promise<void> {
    await this.repository
      .createQueryBuilder()
      .insert()
      .values({
        ...event,
        occurredAt: new Date(event.occurredAt),
        receivedAt: new Date(),
      })
      .onConflict('("event_id") DO NOTHING')
      .execute();
  }

  async findById(eventId: string): Promise<MessageReceipt | null> {
    const receipt = await this.repository.findOneBy({ eventId });
    return receipt
      ? {
          ...receipt,
          occurredAt: receipt.occurredAt.toISOString(),
          receivedAt: receipt.receivedAt.toISOString(),
        }
      : null;
  }
}
