import { randomUUID } from 'node:crypto';
import { MessageCreated, MessageReceipt } from '@app/contracts';

export const event = (): MessageCreated => ({
  schemaVersion: 1,
  eventId: randomUUID(),
  correlationId: randomUUID(),
  occurredAt: new Date().toISOString(),
  message: 'hello',
});
export const receipt = (): MessageReceipt => ({
  ...event(),
  receivedAt: new Date().toISOString(),
});
