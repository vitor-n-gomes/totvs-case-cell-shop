import { Controller } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  KafkaRetriableException,
  Payload,
} from '@nestjs/microservices';
import { messageCreatedSchema } from '@app/contracts';
import {
  DEMO_EVENT_PATTERN,
  DEMO_KAFKA_TRANSPORT,
} from '@app/platform/kafka/kafka.topics';
import { AppLogger } from '@app/platform/logging/app-logger';
import {
  executionContext,
  newTraceContext,
} from '@app/platform/observability/context';
import { ReceiveMessage } from '../use-cases/receive-message';
@Controller()
export class DemoConsumer {
  constructor(
    private readonly receive: ReceiveMessage,
    private readonly logger: AppLogger,
  ) {}
  @EventPattern(DEMO_EVENT_PATTERN, DEMO_KAFKA_TRANSPORT)
  async receiveEvent(
    @Payload() payload: unknown,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    try {
      const event = messageCreatedSchema.parse(payload);
      await executionContext.run(
        newTraceContext(event.correlationId),
        async () => {
          await this.receive.execute(event);
          this.logger.info('demo.message.received', {
            eventId: event.eventId,
            correlationId: event.correlationId,
          });
        },
      );
    } catch (error) {
      this.logger.info('demo.message.processing.failed', {
        topic: context.getTopic(),
        partition: context.getPartition(),
        offset: context.getMessage().offset,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      throw new KafkaRetriableException('Message processing failed');
    }
  }
}
