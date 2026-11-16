import { SetMetadata } from '@nestjs/common';
import { StepName } from '../constants/step-names';
export const ACTIVATION_STEP = 'activation:step';
export const RegisteredStep = (stepName: StepName) =>
  SetMetadata(ACTIVATION_STEP, stepName);
