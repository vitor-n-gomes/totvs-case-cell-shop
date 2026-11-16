import {
  KafkaOptions,
  MessageHandler,
  ServerKafka,
} from '@nestjs/microservices';

// Nest binds both sets of controllers in a hybrid application. Distinct transport IDs
// keep the existing demo and checkout consumer groups subscribed to their own topics.
export class TopicKafkaServer extends ServerKafka {
  constructor(
    options: NonNullable<KafkaOptions['options']>,
    transportId: symbol,
    private readonly eventPattern: string,
    private readonly kafkaTopic: string,
    private readonly onReadinessChange: (isReady: boolean) => void,
  ) {
    super(options);
    this.setTransportId(transportId);
  }

  override addHandler(
    eventPattern: string,
    callback: MessageHandler,
    isEventHandler = false,
    extras: Record<string, unknown> = {},
  ): void {
    super.addHandler(
      eventPattern === this.eventPattern ? this.kafkaTopic : eventPattern,
      callback,
      isEventHandler,
      extras,
    );
  }

  protected override registerConsumerEventListeners(): void {
    super.registerConsumerEventListeners();
    const kafkaConsumer = this.consumer!;

    kafkaConsumer.on(kafkaConsumer.events.GROUP_JOIN, () =>
      this.onReadinessChange(true),
    );

    for (const consumerEvent of [
      kafkaConsumer.events.REBALANCING,
      kafkaConsumer.events.CRASH,
      kafkaConsumer.events.DISCONNECT,
      kafkaConsumer.events.STOP,
    ]) {

      kafkaConsumer.on(consumerEvent, () => this.onReadinessChange(false));

    }
  }

  override async close(): Promise<void> {
    this.onReadinessChange(false);
    await super.close();
  }
}
