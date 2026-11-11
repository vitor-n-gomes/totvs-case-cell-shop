import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { CheckoutEvent, CheckoutInput } from '@app/contracts';
import {
  executionContext,
  newTraceContext,
} from '@app/platform/observability/context';
import { Metrics } from '@app/platform/observability/metrics';
import { Spans } from '@app/platform/observability/spans';
import { StockRepository } from '../inventory/stock.repository';
import { OutboxRepository } from '../messaging/outbox.repository';

export function checkoutHash(input: CheckoutInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        paymentType: input.paymentType,
        dueDate: input.dueDate,
        mainContact: input.mainContact,
        altContact: input.altContact ?? null,
        paymentMethod: input.paymentMethod,
        environment: input.environment,
        items: [...input.items]
          .sort((a, b) => a.productId.localeCompare(b.productId))
          .map(({ productId, quantity }) => ({ productId, quantity })),
      }),
    )
    .digest('hex');
}
@Injectable()
export class Checkout {
  constructor(
    private readonly database: DataSource,
    private readonly stock: StockRepository,
    private readonly outbox: OutboxRepository,
    private readonly config: ConfigService,
    private readonly metrics: Metrics,
    private readonly spans: Spans,
  ) {}
  async execute(
    input: CheckoutInput,
    key: string | undefined,
    correlationId: string,
  ): Promise<{ orderId: string; status: 'PENDING' }> {
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key must contain 1-128 visible ASCII characters',
      );
    if (
      new Set(input.items.map((item) => item.productId)).size !==
      input.items.length
    )
      throw new BadRequestException('Duplicate products are not allowed');
    const hash = checkoutHash(input);
    return this.spans.run('checkout.transaction', async () => {
      try {
        const result = await this.database.transaction(async (manager) => {
          const orderId = randomUUID();
          const inserted: { id: string }[] = await manager.query(
            `INSERT INTO "order" (id,payment_type,due_date,main_contact,alt_contact,payment_method,environment,idempotency_key,request_hash,correlation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
            [
              orderId,
              input.paymentType,
              input.dueDate,
              input.mainContact,
              input.altContact ?? null,
              input.paymentMethod,
              input.environment,
              key,
              hash,
              correlationId,
            ],
          );
          if (!inserted.length) {
            const [existing]: { id: string; request_hash: string }[] =
              await manager.query(
                'SELECT id,request_hash FROM "order" WHERE idempotency_key=$1',
                [key],
              );
            if (existing?.request_hash !== hash)
              throw new ConflictException(
                'Idempotency key already used with different content',
              );
            return { orderId: existing.id, replay: true };
          }
          await this.stock.reserve(
            manager,
            orderId,
            input.items,
            this.config.getOrThrow<number>('RESERVATION_TTL_SECONDS'),
          );
          const context =
            executionContext.getStore() ?? newTraceContext(correlationId);
          const event: CheckoutEvent = {
            schema_version: 1,
            event_id: randomUUID(),
            order_id: orderId,
            correlation_id: correlationId,
            occurred_at: new Date().toISOString(),
            attempt: 1,
            trace_id: context.trace_id,
            parent_span_id: context.span_id,
          };
          await this.outbox.append(
            manager,
            orderId,
            this.config.getOrThrow<string>('CHECKOUT_TOPIC'),
            event,
            `${orderId}:attempt:1`,
          );
          return { orderId, replay: false };
        });
        this.metrics.checkout.inc({
          result: result.replay ? 'replayed' : 'accepted',
        });
        if (!result.replay)
          this.metrics.reservations.inc(
            { result: 'reserved' },
            input.items.length,
          );
        return { orderId: result.orderId, status: 'PENDING' };
      } catch (error) {
        this.metrics.checkout.inc({ result: 'rejected' });
        if (error instanceof HttpException) throw error;
        throw new ServiceUnavailableException(
          'Checkout temporarily unavailable; retry with the same idempotency key',
        );
      }
    });
  }
}
