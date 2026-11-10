import { MessageCreated } from '@app/contracts';

export abstract class MessagePublisher {
  abstract publish(event: MessageCreated): Promise<void>;
}
