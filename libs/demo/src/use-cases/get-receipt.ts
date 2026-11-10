import { Injectable } from '@nestjs/common';
import { MessageReceipt } from '@app/contracts';
import { ReceiptCache } from '../ports/receipt-cache';
import { ReceiptRepository } from '../ports/receipt-repository';

@Injectable()
export class GetReceipt {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly cache: ReceiptCache,
  ) {}

  async execute(eventId: string): Promise<MessageReceipt | null> {
    const cached = await this.cache.get(eventId);
    if (cached) return cached;
    const receipt = await this.receipts.findById(eventId);
    if (receipt) await this.cache.set(receipt);
    return receipt;
  }
}
