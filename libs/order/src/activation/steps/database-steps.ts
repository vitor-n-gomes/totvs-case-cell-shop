import { StepName } from '../constants/step-names';
import { OrderStatus } from '@app/order/domain/shared/types/order.type';
import { Injectable } from '@nestjs/common';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { InventoryError } from '@app/products/inventory/domain/errors/inventory-errors';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { PermanentActivationError } from '../guards/activation-errors';
import { RegisteredStep } from '../decorators/activation-step';
import { ActivationContext, ActivationStep } from './activation-step';
@Injectable()
@RegisteredStep(StepName.ConsumeStockReservationStep)
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
@RegisteredStep(StepName.ActivateOrderStep)
export class ActivateOrderStep implements ActivationStep {
  constructor(private readonly orders: OrderRepository) {}

  async exec(context: ActivationContext): Promise<void> {
    await this.orders.update(context.manager, context.order.id, {
      status: OrderStatus.Active,
    });

    context.order.status = OrderStatus.Active;
  }
}
