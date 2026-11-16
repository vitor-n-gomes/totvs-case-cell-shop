import { Injectable } from '@nestjs/common';
import { CheckoutInitiatedEvent } from '@app/order/messaging/order-events';
import { ActiveOrderUseCase } from '../../../activation/active-order.use-case';

@Injectable()
export class CheckoutInitiatedHandler {
  constructor(private readonly activeOrderUseCase: ActiveOrderUseCase) {}

  execute(event: CheckoutInitiatedEvent): Promise<void> {
    return this.activeOrderUseCase.execute(event);
  }
}
