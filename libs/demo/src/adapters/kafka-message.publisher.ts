import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageCreated } from '@app/contracts';
import { KafkaEvents, KafkaService } from '@app/platform/kafka/kafka.service';
import { MessagePublisher } from '../ports/message-publisher';
@Injectable()
export class KafkaMessagePublisher extends MessagePublisher {
  constructor(
    private readonly kafka: KafkaService,
    private readonly config: ConfigService,
  ) {
    super();
  }
  publish(event: MessageCreated): Promise<void> {
    return this.kafka.produce(
      this.config.getOrThrow<string>('KAFKA_TOPIC'),
      new KafkaEvents(event.eventId, event, {
        'x-correlation-id': event.correlationId,
      }),
    );
  }
}
