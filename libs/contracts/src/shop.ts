import { z } from 'zod';

export enum PaymentType {
  PrePaid = 'PrePaid',
  PostPaid = 'PostPaid',
}

export enum Environment {
  Local = 'Local',
  PreProd = 'PreProd',
  Prod = 'Prod',
}

export enum OrderStatus {
  Pending = 'Pending',
  Active = 'Active',
  Cancelled = 'Cancelled',
}

export enum ProcessingStatus {
  Pending = 'Pending',
  Processing = 'Processing',
  Retrying = 'Retrying',
  Completed = 'Completed',
  Failed = 'Failed',
}

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
  paymentType: PaymentType;
  dueDate: string;
  mainContact: string;
  altContact?: string;
  paymentMethod: string;
  environment: Environment;
  items: { productId: string; quantity: number }[];
}
export interface ProductView {
  id: string;
  name: string;
  productKey: string;
  netPrice: string;
  listPrice: string;
}
