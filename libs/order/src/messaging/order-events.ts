import { z } from 'zod';

export const ORDER_CHECKOUT_INITIATED = 'ORDER_CHECKOUT_INITIATED';
export const ORDER_RESERVATION_EXPIRED = 'ORDER_RESERVATION_EXPIRED';
export const ORDER_ACTIVATED = 'ORDER_ACTIVATED';

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

const checkoutEventSchema = z.strictObject({
  kind: z.literal(ORDER_CHECKOUT_INITIATED),
  data: z.strictObject({
    order_id: z.uuid(),
  }),
  meta: checkoutEventMetaSchema,
});

export type CheckoutInitiatedEvent = z.infer<typeof checkoutEventSchema>;

const reservationExpiredEventSchema = z.strictObject({
  kind: z.literal(ORDER_RESERVATION_EXPIRED),
  data: z.strictObject({
    order_id: z.uuid(),
  }),
  meta: eventMetaSchema.optional(),
});

export type ReservationExpiredEvent = z.infer<
  typeof reservationExpiredEventSchema
>;

export const orderEventSchema = z.discriminatedUnion('kind', [
  checkoutEventSchema,
  reservationExpiredEventSchema,
]);
export type OrderEvent = z.infer<typeof orderEventSchema>;

// In-process only (EventBus, best effort): never published to Kafka.
export interface OrderActivatedEvent {
  kind: typeof ORDER_ACTIVATED;
  data: { order_id: string };
  meta?: EventMeta;
}

export type DomainEvent = OrderEvent | OrderActivatedEvent;

export function parseOrderEvent(payload: unknown): OrderEvent | null {
  const parsed = orderEventSchema.safeParse(payload);

  return parsed.success ? parsed.data : null;
}
