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
  private readonly steps = new Map<StepName, ActivationStep>();
  constructor(
    consume: ConsumeStockReservationStep,
    activate: ActivateOrderStep,
    erp: UpdateErpStep,
    email: EmailNotificationStep,
  ) {
    const reflector = new Reflector();

    for (const step of [consume, activate, erp, email]) {

      const name = reflector.get<StepName>(ACTIVATION_STEP, step.constructor);

      if (!name || this.steps.has(name)) {

        throw new Error('Invalid activation step registration');

      }

      this.steps.set(name, step);

    }

    if (this.steps.size !== Object.values(StepName).length) {

      throw new Error('Missing activation step');

    }
  }

  get(name: StepName): ActivationStep {
    return this.steps.get(name)!;
  }
}
