import { Controller } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  KafkaRetriableException,
  Payload,
} from '@nestjs/microservices';
import {
  ORDER_EVENT_PATTERN,
  ORDER_KAFKA_TRANSPORT,
} from '@app/platform/kafka/kafka.topics';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ProcessOrderEventUseCase } from '../usecases/process-order-event.use-case';
@Controller()
export class OrderConsumer {
  constructor(
    private readonly process: ProcessOrderEventUseCase,
    private readonly logger: AppLogger,
  ) {}

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

      await this.process.handle(payload, {
        topic: context.getTopic(),
        partition: context.getPartition(),
        offset: context.getMessage().offset,
      });

    } catch {

      this.logger.error('checkout.consumer.failed');

      throw new KafkaRetriableException('Checkout processing failed');

    } finally {

      clearInterval(timer);

    }
  }
}
