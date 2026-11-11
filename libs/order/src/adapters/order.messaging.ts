import { KafkaEvents, KafkaService } from "@app/platform/kafka/kafka.service";
import { kafkaTopics } from "@app/platform/kafka/kafka.topics";
import { Injectable } from "@nestjs/common";
import { lastValueFrom } from "rxjs";

export enum OrderEventKinds {
    CREATE_ORDER = "CREATE_ORDER", 
}

export type OrderEvent = | {
    kind: OrderEventKinds.CREATE_ORDER,
    data: any, 
    meta: any
}

@Injectable()
export class OrderMessaging {
    constructor(private readonly kafkaService: KafkaService) {

    }

    async publish(event: KafkaEvents<OrderEvent>) {
        return lastValueFrom(
            this.kafkaService.produce(kafkaTopics.CaseCellShopEvents, event)
        );
    }
}