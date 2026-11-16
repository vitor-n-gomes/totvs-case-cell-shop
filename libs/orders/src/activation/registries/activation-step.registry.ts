import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StepName } from '../constants/step-names';
import { ACTIVATION_STEP } from '../decorators/activation-step';
import { ActivationStep } from '../steps/activation-step';
import {
  ActivateOrderStep,
  ConsumeStockReservationStep,
} from '../steps/database-steps';
import {
  EmailNotificationStep,
  UpdateErpStep,
} from '../steps/integration-steps';

@Injectable()
export class ActivationStepRegistry {
  private readonly activationSteps = new Map<StepName, ActivationStep>();
  constructor(
    consumeStockReservationStep: ConsumeStockReservationStep,
    activateOrderStep: ActivateOrderStep,
    updateErpStep: UpdateErpStep,
    emailNotificationStep: EmailNotificationStep,
  ) {
    const reflector = new Reflector();

    for (const activationStep of [
      consumeStockReservationStep,
      activateOrderStep,
      updateErpStep,
      emailNotificationStep,
    ]) {

      const stepName = reflector.get<StepName>(
        ACTIVATION_STEP,
        activationStep.constructor,
      );

      if (!stepName || this.activationSteps.has(stepName)) {

        throw new Error('Invalid activation step registration');

      }

      this.activationSteps.set(stepName, activationStep);

    }

    if (this.activationSteps.size !== Object.values(StepName).length) {

      throw new Error('Missing activation step');

    }
  }

  get(stepName: StepName): ActivationStep {
    return this.activationSteps.get(stepName)!;
  }
}
