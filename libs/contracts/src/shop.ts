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
export const ORDER_CHECKOUT_INITIATED = 'ORDER_CHECKOUT_INITIATED';
export const ORDER_RESERVATION_EXPIRED = 'ORDER_RESERVATION_EXPIRED';
export const ORDER_CHECKOUT_FAILED = 'ORDER_CHECKOUT_FAILED';
export const ORDER_EVENT_INVALID = 'ORDER_EVENT_INVALID';

const eventMetaSchema = z.strictObject({
  schema_version: z.literal(1),
  event_id: z.uuid(),
  occurred_at: z.iso.datetime(),
  correlation_id: z.uuid(),
  trace_id: z.string().regex(/^[a-f0-9]{32}$/),
  parent_span_id: z.string().regex(/^[a-f0-9]{16}$/),
});
export type EventMeta = z.infer<typeof eventMetaSchema>;
const checkoutEventMetaSchema = eventMetaSchema.extend({
  attempt: z.number().int().min(1).max(5),
});
export type CheckoutEventMeta = z.infer<typeof checkoutEventMetaSchema>;

export const checkoutEventSchema = z.strictObject({
  data: z.strictObject({
    kind: z.literal(ORDER_CHECKOUT_INITIATED),
    data: z.strictObject({ order_id: z.uuid() }),
  }),
  meta: checkoutEventMetaSchema,
});
export type CheckoutInitiatedEvent = z.infer<typeof checkoutEventSchema>;

export const reservationExpiredEventSchema = z.strictObject({
  data: z.strictObject({
    kind: z.literal(ORDER_RESERVATION_EXPIRED),
    data: z.strictObject({ order_id: z.uuid() }),
  }),
  meta: eventMetaSchema,
});
export type ReservationExpiredEvent = z.infer<
  typeof reservationExpiredEventSchema
>;

export const checkoutFailedEventSchema = z.strictObject({
  data: z.strictObject({
    kind: z.literal(ORDER_CHECKOUT_FAILED),
    data: z.strictObject({
      order_id: z.uuid(),
      failure: z.strictObject({
        error_type: z.string(),
        attempt: z.number().int().min(1).max(5),
        event_id: z.uuid(),
      }),
      failed_step: z.string(),
    }),
  }),
  meta: checkoutEventMetaSchema,
});
export type CheckoutFailedEvent = z.infer<typeof checkoutFailedEventSchema>;

export const invalidOrderEventSchema = z.strictObject({
  data: z.strictObject({
    kind: z.literal(ORDER_EVENT_INVALID),
    data: z.strictObject({
      source_topic: z.string(),
      partition: z.number().int().nonnegative(),
      offset: z.string(),
      reason: z.string(),
      order_id: z.uuid().optional(),
    }),
  }),
  meta: eventMetaSchema,
});
export type InvalidOrderEvent = z.infer<typeof invalidOrderEventSchema>;

export const orderEventSchema = z.union([
  checkoutEventSchema,
  reservationExpiredEventSchema,
  checkoutFailedEventSchema,
  invalidOrderEventSchema,
]);
export type OrderEvent = z.infer<typeof orderEventSchema>;

export const legacyCheckoutEventSchema = z.strictObject({
  schema_version: z.literal(1),
  event_id: z.uuid(),
  order_id: z.uuid(),
  correlation_id: z.uuid(),
  occurred_at: z.iso.datetime(),
  attempt: z.number().int().min(1).max(5),
  trace_id: z.string().regex(/^[a-f0-9]{32}$/),
  parent_span_id: z.string().regex(/^[a-f0-9]{16}$/),
});
export type CheckoutEvent = z.infer<typeof legacyCheckoutEventSchema>;

const legacyCheckoutFailedEventSchema = legacyCheckoutEventSchema.extend({
  failure: z.strictObject({
    error_type: z.string(),
    attempt: z.number().int().min(1).max(5),
    event_id: z.uuid(),
  }),
  failed_step: z.string(),
});

export function normalizeOrderEvent(payload: unknown): OrderEvent | null {
  const parsed = orderEventSchema.safeParse(payload);
  if (parsed.success) return parsed.data;

  const legacyFailure = legacyCheckoutFailedEventSchema.safeParse(payload);
  if (legacyFailure.success) {
    const event = legacyFailure.data;
    return {
      data: {
        kind: ORDER_CHECKOUT_FAILED,
        data: {
          order_id: event.order_id,
          failure: event.failure,
          failed_step: event.failed_step,
        },
      },
      meta: {
        schema_version: event.schema_version,
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        correlation_id: event.correlation_id,
        trace_id: event.trace_id,
        parent_span_id: event.parent_span_id,
        attempt: event.attempt,
      },
    };
  }

  const legacy = legacyCheckoutEventSchema.safeParse(payload);
  if (!legacy.success) return null;

  const event = legacy.data;
  const normalized = {
    data: {
      kind: ORDER_CHECKOUT_INITIATED,
      data: { order_id: event.order_id },
    },
    meta: {
      schema_version: event.schema_version,
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      correlation_id: event.correlation_id,
      trace_id: event.trace_id,
      parent_span_id: event.parent_span_id,
      attempt: event.attempt,
    },
  };
  const migrated = checkoutEventSchema.safeParse(normalized);
  return migrated.success ? migrated.data : null;
}

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
  netPrice: number;
  listPrice: number;
}
