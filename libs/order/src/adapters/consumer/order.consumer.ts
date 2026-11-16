import { Controller } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import {
  ORDER_EVENT_PATTERN,
  ORDER_KAFKA_TRANSPORT,
} from '@app/platform/kafka/kafka.topics';
import { parseOrderEvent } from '@app/order/messaging/order-events';
import { ProcessOrderEventUseCase } from '../usecases/process-order-event.use-case';
@Controller()
export class OrderConsumer {
  constructor(private readonly process: ProcessOrderEventUseCase) {}

  @EventPattern(ORDER_EVENT_PATTERN, ORDER_KAFKA_TRANSPORT)
  async orderEvent(
    @Payload() payload: unknown,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    const timer = setInterval(() => {
      void context
        .getHeartbeat()()
        .catch(() => undefined);
    }, 1000);

    try {

      const event = parseOrderEvent(payload);

      if (!event) {

        throw new RpcException('Invalid event payload');

      }

      await this.process.handle(event);

    } finally {

      clearInterval(timer);

    }
  }
}
