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
import { parseOrderEvent } from '../../messaging/order-events';
import { ProcessOrderEventUseCase } from '../usecases/process-order-event.use-case';
@Controller()
export class OrderConsumer {
  constructor(
    private readonly processOrderEventUseCase: ProcessOrderEventUseCase,
  ) {}

  @EventPattern(ORDER_EVENT_PATTERN, ORDER_KAFKA_TRANSPORT)
  async orderEvent(
    @Payload() payload: unknown,
    @Ctx() kafkaContext: KafkaContext,
  ): Promise<void> {
    const heartbeatInterval = setInterval(() => {
      void kafkaContext
        .getHeartbeat()()
        .catch(() => undefined);
    }, 1000);

    try {

      const event = parseOrderEvent(payload);

      if (!event) {

        throw new RpcException('Invalid event payload');

      }

      await this.processOrderEventUseCase.handle(event);

    } finally {

      clearInterval(heartbeatInterval);

    }
  }
}
