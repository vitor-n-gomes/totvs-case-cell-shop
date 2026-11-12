import { Injectable } from '@nestjs/common';
import { ReservationRepository } from '@app/shop/inventory/reservation.repository';
import { InventoryError } from '@app/shop/inventory/inventory-errors';
import { OrderRepository } from '../../repositories/order.repository';
import { PermanentActivationError } from '../guards/activation-errors';
import { RegisteredStep } from '../decorators/activation-step';
import { ActivationContext, ActivationStep } from './activation-step';
@Injectable()
@RegisteredStep('ConsumeStockReservationStep')
export class ConsumeStockReservationStep implements ActivationStep {
  constructor(private readonly reservations: ReservationRepository) {}
  async exec(context: ActivationContext): Promise<void> {
    try {
      context.consumedReservations = await this.reservations.consume(
        context.manager,
        context.order.id,
      );
    } catch (error) {
      if (error instanceof InventoryError)
        throw new PermanentActivationError(error.message, { cause: error });
      throw error;
    }
  }
}
@Injectable()
@RegisteredStep('ActivateOrderStep')
export class ActivateOrderStep implements ActivationStep {
  constructor(private readonly orders: OrderRepository) {}
  async exec(context: ActivationContext): Promise<void> {
    await this.orders.update(context.manager, context.order.id, {
      status: 'ACTIVE',
    });
    context.order.status = 'ACTIVE';
  }
}
