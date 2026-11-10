import { MessageCreated, MessageReceipt } from '@app/contracts';

export abstract class ReceiptRepository {
  abstract saveOnce(event: MessageCreated): Promise<void>;
  abstract findById(eventId: string): Promise<MessageReceipt | null>;
}
