import { Injectable, Logger } from "@nestjs/common";
import { OrderEvent, OrderEventKinds } from "../order.messaging";
import { ErrorReply } from "redis";
import { CreateOrderStrategy } from "./strategies/create-order.strategy";

@Injectable()
export class ProcessOrderEventUseCase {
    private readonly logger = new Logger(ProcessOrderEventUseCase.name);

    constructor(private readonly createOrderStrategy: CreateOrderStrategy) { }

    async handle(payload: OrderEvent) {
        try {
            switch (payload.kind) {
                case OrderEventKinds.CREATE_ORDER:
                    return await this.createOrderStrategy.handle(payload);

            }
        } catch (error) {
            this.logger.error(
                `Error processing order event: ${payload.kind}`,
                error instanceof Error ? error.stack : String(Error)
            );
        }
    }
}