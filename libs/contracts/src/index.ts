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
  PAYMENT_TYPES,
  ENVIRONMENTS,
  ORDER_STATUSES,
  PROCESSING_STATUSES,
  CHECKOUT_TOPIC,
  checkoutEventSchema,
} from './shop';
export type { CheckoutEvent, CheckoutInput, ProductView } from './shop';
