import { EntityManager } from 'typeorm';
import { CheckoutInitiatedEvent } from '../../messaging/order-events';
import { OrderEntity } from '../../domain/entities';
import { StepName } from '../constants/step-names';
export interface ActivationContext {
  order: OrderEntity;
  correlationId: string;
  event: CheckoutInitiatedEvent;
  entityManager: EntityManager;
  consumedReservationCount?: number;
  currentStep: StepName;
}
export interface ActivationStep {
  exec(activationContext: ActivationContext): Promise<void>;
  shouldExecute?(activationContext: ActivationContext): boolean;
}
