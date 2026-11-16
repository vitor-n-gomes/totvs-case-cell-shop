import { StepName } from '../constants/step-names';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '@app/platform/logging/app-logger';
import { RegisteredStep } from '../decorators/activation-step';
import {
  IntegrationTimeoutError,
  PermanentActivationError,
} from '../guards/activation-errors';
import { ActivationContext, ActivationStep } from './activation-step';

@Injectable()
export class IntegrationSimulator {
  constructor(
    private readonly configService: ConfigService,
    private readonly appLogger: AppLogger,
  ) {}

  async execute(
    integrationKind: 'erp' | 'email',
    activationContext: ActivationContext,
  ): Promise<void> {
    const timeoutMs = this.configService.getOrThrow<number>(
      'SIMULATOR_TIMEOUT_MS',
    );

    const delayMs = this.configService.getOrThrow<number>('SIMULATOR_DELAY_MS');

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delayMs, timeoutMs)),
    );

    if (delayMs > timeoutMs) {

      throw new IntegrationTimeoutError('Integration timeout');

    }

    if (
      this.configService.getOrThrow<string>('SIMULATOR_PERMANENT_FAILURE') ===
      integrationKind
    ) {

      throw new PermanentActivationError('Integration rejected request');

    }

    if (
      activationContext.event.meta.attempt <=
      this.configService.getOrThrow<number>(
        integrationKind === 'erp' ? 'ERP_FAILURES' : 'EMAIL_FAILURES',
      )
    ) {

      throw new Error('Simulated transient integration failure');

    }

    this.appLogger.info(`integration.${integrationKind}.accepted`, {
      order_id: activationContext.order.id,
      idempotency_key: `${activationContext.order.id}:${integrationKind}`,
    });
  }
}
@Injectable()
@RegisteredStep(StepName.UpdateErpStep)
export class UpdateErpStep implements ActivationStep {
  constructor(private readonly integrationSimulator: IntegrationSimulator) {}

  exec(activationContext: ActivationContext): Promise<void> {
    return this.integrationSimulator.execute('erp', activationContext);
  }
}
@Injectable()
@RegisteredStep(StepName.EmailNotificationStep)
export class EmailNotificationStep implements ActivationStep {
  constructor(private readonly integrationSimulator: IntegrationSimulator) {}

  exec(activationContext: ActivationContext): Promise<void> {
    return this.integrationSimulator.execute('email', activationContext);
  }
}
