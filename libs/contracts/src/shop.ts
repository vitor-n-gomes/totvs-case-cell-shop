import { z } from 'zod';

export const PAYMENT_TYPES = ['PREPAID', 'POSTPAID'] as const;
export const ENVIRONMENTS = ['LOCAL', 'PRE_PROD', 'PROD'] as const;
export const ORDER_STATUSES = ['PENDING', 'ACTIVE', 'CANCELLED'] as const;
export const PROCESSING_STATUSES = [
  'PENDING',
  'PROCESSING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
] as const;
export const CHECKOUT_TOPIC = 'order.checkout.initiated';
export const checkoutEventSchema = z.strictObject({
  schema_version: z.literal(1),
  event_id: z.uuid(),
  order_id: z.uuid(),
  correlation_id: z.uuid(),
  occurred_at: z.iso.datetime(),
  attempt: z.number().int().min(1).max(5),
  trace_id: z.string().regex(/^[a-f0-9]{32}$/),
  parent_span_id: z.string().regex(/^[a-f0-9]{16}$/),
});
export type CheckoutEvent = z.infer<typeof checkoutEventSchema>;
export interface CheckoutInput {
  paymentType: (typeof PAYMENT_TYPES)[number];
  dueDate: string;
  mainContact: string;
  altContact?: string;
  paymentMethod: string;
  environment: (typeof ENVIRONMENTS)[number];
  items: { productId: string; quantity: number }[];
}
export interface ProductView {
  id: string;
  name: string;
  productKey: string;
  netPrice: string;
  listPrice: string;
}
