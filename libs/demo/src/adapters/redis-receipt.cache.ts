import { Injectable } from '@nestjs/common';
import { MessageReceipt, messageReceiptSchema } from '@app/contracts';
import { RedisConnection } from '@app/platform/cache/redis-connection';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ReceiptCache } from '../ports/receipt-cache';

export const RECEIPT_TTL_SECONDS = 30;
export const receiptCacheKey = (eventId: string): string =>
  `casecellshop:demo:receipt:v1:${eventId}`;

@Injectable()
export class RedisReceiptCache extends ReceiptCache {
  constructor(
    private readonly redis: RedisConnection,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  async get(eventId: string): Promise<MessageReceipt | null> {
    if (!this.redis.client.isReady) return null;
    try {
      const value = await this.redis.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
        .get(receiptCacheKey(eventId));
      if (!value) return null;
      const parsed = messageReceiptSchema.safeParse(JSON.parse(value));
      return parsed.success && parsed.data.eventId === eventId
        ? parsed.data
        : null;
    } catch {
      this.logger.info('cache.read.fallback', { eventId });
      return null;
    }
  }

  async set(receipt: MessageReceipt): Promise<void> {
    if (!this.redis.client.isReady) return;
    try {
      await this.redis.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
        .set(receiptCacheKey(receipt.eventId), JSON.stringify(receipt), {
          EX: RECEIPT_TTL_SECONDS,
        });
    } catch {
      this.logger.info('cache.write.skipped', {
        eventId: receipt.eventId,
        correlationId: receipt.correlationId,
      });
    }
  }
}
