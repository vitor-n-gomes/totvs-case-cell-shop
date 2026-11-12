import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { LoggingModule } from '../logging/logging.module';
import { KafkaService } from './kafka.service';
import { kafkaClientOptions } from './kafka.options';
import { KAFKA_CLIENT } from './kafka.topics';
@Module({
  imports: [
    LoggingModule,
    ClientsModule.registerAsync([
      {
        name: KAFKA_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            postfixId: '',
            producerOnlyMode: true,
            client: kafkaClientOptions(config),
            producer: { allowAutoTopicCreation: false },
            send: { acks: -1 },
          },
        }),
      },
    ]),
  ],
  providers: [KafkaService],
  exports: [KafkaService],
})
export class KafkaModule {}
