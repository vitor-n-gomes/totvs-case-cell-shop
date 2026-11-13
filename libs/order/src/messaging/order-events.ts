import { z } from 'zod';

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

const checkoutEventSchema = z.strictObject({
  data: z.strictObject({
    kind: z.literal(ORDER_CHECKOUT_INITIATED),
    data: z.strictObject({ order_id: z.uuid() }),
  }),
  meta: checkoutEventMetaSchema,
});
export type CheckoutInitiatedEvent = z.infer<typeof checkoutEventSchema>;

const reservationExpiredEventSchema = z.strictObject({
  data: z.strictObject({
    kind: z.literal(ORDER_RESERVATION_EXPIRED),
    data: z.strictObject({ order_id: z.uuid() }),
  }),
  meta: eventMetaSchema,
});

const checkoutFailedEventSchema = z.strictObject({
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

const invalidOrderEventSchema = z.strictObject({
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

const orderEventSchema = z.union([
  checkoutEventSchema,
  reservationExpiredEventSchema,
  checkoutFailedEventSchema,
  invalidOrderEventSchema,
]);

const legacyCheckoutEventSchema = z.strictObject({
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

export function normalizeOrderEvent(
  payload: unknown,
): z.infer<typeof orderEventSchema> | null {
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
