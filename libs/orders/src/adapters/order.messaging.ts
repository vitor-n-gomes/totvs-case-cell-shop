import { Injectable } from '@nestjs/common';
import { KafkaEvents, KafkaService } from '@app/platform/kafka/kafka.service';

@Injectable()
export class OrderMessaging {
  constructor(private readonly kafkaService: KafkaService) {}

  ensureConnected(): Promise<void> {
    return this.kafkaService.ensureConnected();
  }

  publish(
    topic: string,
    messageKey: string,
    payload: object,
    headers: Record<string, string> = {},
  ): Promise<void> {
    return this.kafkaService.produce(
      topic,
      new KafkaEvents(messageKey, payload, headers),
    );
  }
}
