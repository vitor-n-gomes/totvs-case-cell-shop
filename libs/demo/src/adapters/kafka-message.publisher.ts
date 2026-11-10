import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageCreated } from '@app/contracts';
import { KafkaConnection } from '@app/platform/messaging/kafka-connection';
import { MessagePublisher } from '../ports/message-publisher';

@Injectable()
export class KafkaMessagePublisher extends MessagePublisher {
  constructor(
    private readonly kafka: KafkaConnection,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async publish(event: MessageCreated): Promise<void> {
    await this.kafka.producer.send({
      topic: this.config.getOrThrow<string>('KAFKA_TOPIC'),
      acks: -1,
      messages: [
        {
          key: event.eventId,
          value: JSON.stringify(event),
          headers: { 'x-correlation-id': event.correlationId },
        },
      ],
    });
  }
}
