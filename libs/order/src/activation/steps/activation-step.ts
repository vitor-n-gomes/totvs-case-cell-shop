import { EntityManager } from 'typeorm';
import { CheckoutInitiatedEvent } from '@app/order/messaging/order-events';
import { OrderEntity } from '../../domain/entities';
import { StepName } from '../constants/step-names';
export interface ActivationContext {
  order: OrderEntity;
  correlationId: string;
  event: CheckoutInitiatedEvent;
  manager: EntityManager;
  consumedReservations?: number;
  currentStep: StepName;
}
export interface ActivationStep {
  exec(context: ActivationContext): Promise<void>;
  shouldExecute?(context: ActivationContext): boolean;
}
