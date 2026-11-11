import { kafkaTopics } from "@app/platform/kafka/kafka.topics";
import { Inject } from "@nestjs/common";
import { Ctx, EventPattern, KafkaContext, Payload } from "@nestjs/microservices";
import type { OrderEvent } from "../order.messaging";
import { ProcessOrderEventUseCase } from "../usecases/process-order-event.use-case";

export class OrderConsumer {
    constructor(
        @Inject("STRATEGY_INITIALIZER") private readonly _strategyInit: unknown,
        private readonly processOrderEventUseCase: ProcessOrderEventUseCase,
    ) { }

    @EventPattern(kafkaTopics.CaseCellShopEvents)
    orderEvent(
        @Payload() payload: OrderEvent,
        @Ctx() context: KafkaContext
    ) {

        return this.processOrderEventUseCase.handle(payload);

    }
}