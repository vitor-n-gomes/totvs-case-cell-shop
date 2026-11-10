import { MessageReceipt } from '@app/contracts';

export abstract class ReceiptCache {
  abstract get(eventId: string): Promise<MessageReceipt | null>;
  abstract set(receipt: MessageReceipt): Promise<void>;
}
