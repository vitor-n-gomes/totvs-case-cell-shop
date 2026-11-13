import { z } from 'zod';

export const DEMO_MESSAGE_TOPIC = 'casecellshop.demo.message-created.v1';

export const messageCreatedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  correlationId: z.uuid(),
  message: z.string().max(500).regex(/\S/, 'Message must not be blank'),
});

export type MessageCreated = z.infer<typeof messageCreatedSchema>;

export const messageReceiptSchema = messageCreatedSchema.extend({
  receivedAt: z.iso.datetime(),
});

export type MessageReceipt = z.infer<typeof messageReceiptSchema>;

export {
  PaymentType,
  Environment,
  OrderStatus,
  ProcessingStatus,
  CHECKOUT_TOPIC,
  ORDER_CHECKOUT_INITIATED,
  ORDER_RESERVATION_EXPIRED,
  ORDER_CHECKOUT_FAILED,
  ORDER_EVENT_INVALID,
  checkoutEventSchema,
  reservationExpiredEventSchema,
  checkoutFailedEventSchema,
  invalidOrderEventSchema,
  orderEventSchema,
  legacyCheckoutEventSchema,
  normalizeOrderEvent,
} from './shop';
export type {
  CheckoutEvent,
  CheckoutInitiatedEvent,
  CheckoutEventMeta,
  EventMeta,
  ReservationExpiredEvent,
  CheckoutFailedEvent,
  InvalidOrderEvent,
  OrderEvent,
  CheckoutInput,
  ProductView,
} from './shop';
