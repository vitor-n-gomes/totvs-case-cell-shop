import { Injectable } from '@nestjs/common';
import { KafkaEvents, KafkaService } from '@app/platform/kafka/kafka.service';
import { CheckoutEvent } from '@app/contracts';
export type OrderEvent = CheckoutEvent;
@Injectable()
export class OrderMessaging {
  constructor(private readonly kafka: KafkaService) {}
  ensureConnected(): Promise<void> {
    return this.kafka.ensureConnected();
  }
  publish(
    topic: string,
    key: string,
    payload: object,
    headers: Record<string, string> = {},
  ): Promise<void> {
    return this.kafka.produce(topic, new KafkaEvents(key, payload, headers));
  }
}
