import { Injectable } from '@nestjs/common';
import { messageCreatedSchema } from '@app/contracts';
import { ReceiptRepository } from '../ports/receipt-repository';

@Injectable()
export class ReceiveMessage {
  constructor(private readonly receipts: ReceiptRepository) {}

  async execute(payload: unknown): Promise<void> {
    const event = messageCreatedSchema.parse(payload);
    await this.receipts.saveOnce(event);
  }
}
