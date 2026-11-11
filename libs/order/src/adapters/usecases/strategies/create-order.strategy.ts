import { Injectable, Logger} from "@nestjs/common";
import { OrderEvent } from "../../order.messaging";

@Injectable()
export class CreateOrderStrategy {
    private readonly Logger = new Logger(CreateOrderStrategy.name);

    construct(){}

    async handle(payload: OrderEvent): Promise<void>{}
}