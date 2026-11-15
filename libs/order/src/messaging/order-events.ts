import { z } from 'zod';

export const ORDER_CHECKOUT_INITIATED = 'ORDER_CHECKOUT_INITIATED';
export const ORDER_RESERVATION_EXPIRED = 'ORDER_RESERVATION_EXPIRED';
export const ORDER_CHECKOUT_FAILED = 'ORDER_CHECKOUT_FAILED';
export const ORDER_EVENT_INVALID = 'ORDER_EVENT_INVALID';
export const ORDER_ACTIVATED = 'ORDER_ACTIVATED';

// Every key in an event envelope is snake_case: { kind, data, meta? }.
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

const checkoutInitiatedEventSchema = z.strictObject({
  kind: z.literal(ORDER_CHECKOUT_INITIATED),
  data: z.strictObject({ order_id: z.uuid() }),
  meta: checkoutEventMetaSchema,
});
export type CheckoutInitiatedEvent = z.infer<
  typeof checkoutInitiatedEventSchema
>;

const reservationExpiredEventSchema = z.strictObject({
  kind: z.literal(ORDER_RESERVATION_EXPIRED),
  data: z.strictObject({ order_id: z.uuid() }),
  meta: eventMetaSchema.optional(),
});
export type ReservationExpiredEvent = z.infer<
  typeof reservationExpiredEventSchema
>;

const checkoutFailedEventSchema = z.strictObject({
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
  meta: checkoutEventMetaSchema,
});
export type CheckoutFailedEvent = z.infer<typeof checkoutFailedEventSchema>;

const invalidOrderEventSchema = z.strictObject({
  kind: z.literal(ORDER_EVENT_INVALID),
  data: z.strictObject({
    source_topic: z.string(),
    partition: z.number().int().nonnegative(),
    offset: z.string(),
    reason: z.string(),
    order_id: z.uuid().optional(),
  }),
  meta: eventMetaSchema.optional(),
});
export type InvalidOrderEvent = z.infer<typeof invalidOrderEventSchema>;

const orderEventSchema = z.discriminatedUnion('kind', [
  checkoutInitiatedEventSchema,
  reservationExpiredEventSchema,
  checkoutFailedEventSchema,
  invalidOrderEventSchema,
]);
/** Events that travel through Kafka. */
export type OrderEvent = z.infer<typeof orderEventSchema>;

// In-process only: dispatched through the EventBus after an activation commit.
export const orderActivatedEventSchema = z.strictObject({
  kind: z.literal(ORDER_ACTIVATED),
  data: z.strictObject({ order_id: z.uuid() }),
  meta: eventMetaSchema.optional(),
});
export type OrderActivatedEvent = z.infer<typeof orderActivatedEventSchema>;

/** Every event a handler registered in the EventBus can receive. */
export type DomainEvent = OrderEvent | OrderActivatedEvent;

export function parseOrderEvent(payload: unknown): OrderEvent | null {
  const parsed = orderEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
