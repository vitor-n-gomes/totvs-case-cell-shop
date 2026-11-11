import { Module } from "@nestjs/common";
import { KafkaService } from "./kafka.service";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";

@Module({
    imports: [
        ClientsModule.registerAsync({
            isGlobal: true,
            clients: [{
                name: "case_cell_client",
                inject: [ConfigService],
                useFactory: (configService: ConfigService) => {
                    const brokers: string[] = configService.getOrThrow<string>("kafka.brokers")?.split(',');

                    return {
                        transport: Transport.KAFKA,
                        options: {
                            postfixId: "",
                            producerOnlyMode: true,
                            client: {
                                clientId: "case_cell_client",
                                brokers
                            }
                        }
                    }
                }
            }]
        })

    ],
    exports: [KafkaService],
    providers: [KafkaService]
})
export class KafkaModule { }