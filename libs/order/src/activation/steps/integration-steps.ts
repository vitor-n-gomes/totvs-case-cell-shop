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
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  async execute(
    kind: 'erp' | 'email',
    context: ActivationContext,
  ): Promise<void> {
    const timeout = this.config.getOrThrow<number>('SIMULATOR_TIMEOUT_MS');
    const delay = this.config.getOrThrow<number>('SIMULATOR_DELAY_MS');

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delay, timeout)),
    );

    if (delay > timeout) {

      throw new IntegrationTimeoutError('Integration timeout');

    }

    if (
      this.config.getOrThrow<string>('SIMULATOR_PERMANENT_FAILURE') === kind
    ) {

      throw new PermanentActivationError('Integration rejected request');

    }

    if (
      context.event.meta.attempt <=
      this.config.getOrThrow<number>(
        kind === 'erp' ? 'ERP_FAILURES' : 'EMAIL_FAILURES',
      )
    ) {

      throw new Error('Simulated transient integration failure');

    }

    this.logger.info(`integration.${kind}.accepted`, {
      order_id: context.order.id,
      idempotency_key: `${context.order.id}:${kind}`,
    });
  }
}
@Injectable()
@RegisteredStep(StepName.UpdateErpStep)
export class UpdateErpStep implements ActivationStep {
  constructor(private readonly simulator: IntegrationSimulator) {}

  exec(context: ActivationContext): Promise<void> {
    return this.simulator.execute('erp', context);
  }
}
@Injectable()
@RegisteredStep(StepName.EmailNotificationStep)
export class EmailNotificationStep implements ActivationStep {
  constructor(private readonly simulator: IntegrationSimulator) {}

  exec(context: ActivationContext): Promise<void> {
    return this.simulator.execute('email', context);
  }
}
