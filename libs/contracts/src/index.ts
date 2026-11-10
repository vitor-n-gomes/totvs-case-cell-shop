import { z } from 'zod';

export const DEMO_MESSAGE_TOPIC = 'casecellshop.demo.message-created.v1';

export const messageCreatedSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    correlationId: z.string().uuid(),
    message: z.string().max(500).regex(/\S/, 'Message must not be blank'),
  })
  .strict();

export type MessageCreated = z.infer<typeof messageCreatedSchema>;

export const messageReceiptSchema = messageCreatedSchema.extend({
  receivedAt: z.string().datetime(),
});

export type MessageReceipt = z.infer<typeof messageReceiptSchema>;
