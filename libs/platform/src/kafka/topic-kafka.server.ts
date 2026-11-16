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
    private readonly pattern: string,
    private readonly topic: string,
    private readonly ready: (value: boolean) => void,
  ) {
    super(options);
    this.setTransportId(transportId);
  }

  override addHandler(
    pattern: string,
    callback: MessageHandler,
    isEventHandler = false,
    extras: Record<string, unknown> = {},
  ): void {
    super.addHandler(
      pattern === this.pattern ? this.topic : pattern,
      callback,
      isEventHandler,
      extras,
    );
  }

  protected override registerConsumerEventListeners(): void {
    super.registerConsumerEventListeners();
    const consumer = this.consumer!;

    consumer.on(consumer.events.GROUP_JOIN, () => this.ready(true));

    for (const event of [
      consumer.events.REBALANCING,
      consumer.events.CRASH,
      consumer.events.DISCONNECT,
      consumer.events.STOP,
    ])
      consumer.on(event, () => this.ready(false));
  }

  override async close(): Promise<void> {
    this.ready(false);
    await super.close();
  }
}
