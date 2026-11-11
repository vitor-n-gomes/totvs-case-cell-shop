import { Injectable } from '@nestjs/common';
import { ReservationRepository } from '../../inventory/reservation.repository';
import { RegisteredStep } from '../decorators/activation-step';
import { ActivationContext, ActivationStep } from './activation-step';

@Injectable()
@RegisteredStep('ConsumeStockReservationStep')
export class ConsumeStockReservationStep implements ActivationStep {
  constructor(private readonly reservations: ReservationRepository) {}
  async exec(context: ActivationContext): Promise<void> {
    context.consumedReservations = await this.reservations.consume(
      context.manager,
      context.order.id,
    );
  }
}
@Injectable()
@RegisteredStep('ActivateOrderStep')
export class ActivateOrderStep implements ActivationStep {
  async exec(context: ActivationContext): Promise<void> {
    await context.manager.query(
      'UPDATE "order" SET status=\'ACTIVE\' WHERE id=$1',
      [context.order.id],
    );
    context.order.status = 'ACTIVE';
  }
}
