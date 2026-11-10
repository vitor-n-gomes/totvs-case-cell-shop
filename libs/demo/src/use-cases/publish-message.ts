import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { messageCreatedSchema } from '@app/contracts';
import { MessagePublisher } from '../ports/message-publisher';

@Injectable()
export class PublishMessage {
  constructor(private readonly publisher: MessagePublisher) {}

  async execute(
    message: string,
    correlationId: string,
  ): Promise<{ eventId: string; status: 'published' }> {
    const event = messageCreatedSchema.parse({
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId,
      message,
    });
    await this.publisher.publish(event);
    return { eventId: event.eventId, status: 'published' };
  }
}
