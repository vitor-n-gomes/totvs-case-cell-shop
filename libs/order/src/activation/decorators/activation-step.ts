import { SetMetadata } from '@nestjs/common';
import { StepName } from '../constants/step-names';
export const ACTIVATION_STEP = 'activation:step';
export const RegisteredStep = (name: StepName) =>
  SetMetadata(ACTIVATION_STEP, name);
