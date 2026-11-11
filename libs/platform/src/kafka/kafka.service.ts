import { Inject, Injectable, Logger } from "@nestjs/common";
import { ClientKafka } from "@nestjs/microservices";
import { retry, tap } from "rxjs";

export class KafkaEvents<T extends { kind: string; data: any, meta?: any }> {
    constructor(
        public readonly key: string,
        public readonly value: T,
        public readonly headers: Record<string, any> = {
            "content-type": "application/json"
        }
    ) { }
}

@Injectable()
export class KafkaService {
    constructor(
        @Inject("case_cell_client")
        private readonly client: ClientKafka,
    ) { }

    private readonly logger = new Logger(KafkaService.name)

    produce<T extends { kind: string; data: any }>(
        topic: string,
        event: KafkaEvents<T>,
    ) {
        const { key, headers, value } = event;

        return this.client.emit(topic, { key, headers, value: JSON.stringify(value) }).pipe(
            retry({ count: 1, delay: 5000, resetOnSuccess: true }),
            tap((result) =>
                this.logger.debug(
                    "A Kafka events was produced. Topic: %s. Data: %s. Result: %o.",
                    topic,
                    event.key,
                    result,
                ))
        )

    }
}