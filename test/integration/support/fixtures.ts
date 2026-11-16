import { randomUUID } from 'node:crypto';
import {
  Environment,
  PaymentType,
} from '@app/orders/domain/shared/types/order.type';

export function buildCheckoutPayload(productId: string, quantity = 1) {
  return {
    paymentType: PaymentType.PrePaid,
    dueDate: '2026-11-10',
    mainContact: 'customer@example.test',
    paymentMethod: 'PIX',
    environment: Environment.Local,
    items: [{ productId, quantity }],
  };
}

export const newIdempotencyKey = (): string => `it-${randomUUID()}`;

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
