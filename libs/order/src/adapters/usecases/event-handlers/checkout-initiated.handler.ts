import { Injectable } from '@nestjs/common';
import { CheckoutEvent, CheckoutInitiatedEvent } from '@app/contracts';
import { ActiveOrderUseCase } from '../../../activation/active-order.use-case';

@Injectable()
export class CheckoutInitiatedHandler {
  constructor(private readonly activation: ActiveOrderUseCase) {}

  execute(event: CheckoutInitiatedEvent): Promise<void> {
    const activationEvent: CheckoutEvent = {
      schema_version: event.meta.schema_version,
      event_id: event.meta.event_id,
      order_id: event.data.data.order_id,
      correlation_id: event.meta.correlation_id,
      occurred_at: event.meta.occurred_at,
      attempt: event.meta.attempt,
      trace_id: event.meta.trace_id,
      parent_span_id: event.meta.parent_span_id,
    };
    return this.activation.execute(activationEvent);
  }
}
