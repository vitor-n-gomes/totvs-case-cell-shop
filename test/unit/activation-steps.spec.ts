import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ActivationStepRegistry } from '@app/orders/activation/registries/activation-step.registry';
import {
  ConsumeStockReservationStep,
  ActivateOrderStep,
} from '@app/orders/activation/steps/database-steps';
import {
  EmailNotificationStep,
  IntegrationSimulator,
  UpdateErpStep,
} from '@app/orders/activation/steps/integration-steps';
import {
  PermanentActivationError,
  IntegrationTimeoutError,
} from '@app/orders/activation/guards/activation-errors';
import { StepName } from '@app/orders/activation/constants/step-names';
import { OrderRepository } from '@app/orders/repositories/order.repository';
import { OrderStatus } from '@app/orders/domain/shared/types/order.type';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { ReservationExpiredError } from '@app/products/inventory/domain/errors/inventory-errors';
import { AppLogger } from '@app/platform/logging/app-logger';
import { activationFixture, loggerMock } from './support/fixtures';

describe('activation steps', () => {
  async function setup(config: Record<string, unknown> = {}) {
    const reservations = { consume: jest.fn().mockResolvedValue(2) };
    const repository = { update: jest.fn().mockResolvedValue(undefined) };
    const logger = loggerMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ActivationStepRegistry,
        ConsumeStockReservationStep,
        ActivateOrderStep,
        UpdateErpStep,
        EmailNotificationStep,
        IntegrationSimulator,
        { provide: ReservationRepository, useValue: reservations },
        { provide: OrderRepository, useValue: repository },
        { provide: AppLogger, useValue: logger },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            SIMULATOR_TIMEOUT_MS: 100,
            SIMULATOR_DELAY_MS: 10,
            SIMULATOR_PERMANENT_FAILURE: 'none',
            ERP_FAILURES: 0,
            EMAIL_FAILURES: 0,
            ...config,
          }),
        },
      ],
    }).compile();

    return {
      registry: moduleRef.get(ActivationStepRegistry),
      simulator: moduleRef.get(IntegrationSimulator),
      reservations,
      repository,
      logger,
    };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers every concrete step and records consumed reservation count', async () => {
    const { registry, reservations } = await setup();
    const { context } = activationFixture();

    for (const name of Object.values(StepName)) {

      expect(registry.get(name)).toBeDefined();

    }

    await registry.get(StepName.ConsumeStockReservationStep).exec(context);
    expect(context.consumedReservationCount).toBe(2);

    expect(reservations.consume).toHaveBeenCalledWith(
      context.entityManager,
      context.order.id,
    );
  });

  it('maps expired inventory to a permanent activation failure with the original cause', async () => {
    const { registry, reservations } = await setup();
    const { context } = activationFixture();
    const failure = new ReservationExpiredError('reservation expired');

    reservations.consume.mockRejectedValue(failure);

    await expect(
      registry.get(StepName.ConsumeStockReservationStep).exec(context),
    ).rejects.toMatchObject({
      name: 'PermanentActivationError',
      cause: failure,
    });
  });

  it('preserves unexpected stock failures for retry', async () => {
    const { registry, reservations } = await setup();
    const { context } = activationFixture();
    const failure = new Error('database unavailable');

    reservations.consume.mockRejectedValue(failure);

    await expect(
      registry.get(StepName.ConsumeStockReservationStep).exec(context),
    ).rejects.toBe(failure);
  });

  it('updates in-memory business status only after persistence succeeds', async () => {
    const { registry, repository } = await setup();
    const { context } = activationFixture();
    const failure = new Error('write failed');

    repository.update.mockRejectedValueOnce(failure);

    await expect(
      registry.get(StepName.ActivateOrderStep).exec(context),
    ).rejects.toBe(failure);

    expect(context.order.status).toBe(OrderStatus.Pending);
    await registry.get(StepName.ActivateOrderStep).exec(context);
    expect(context.order.status).toBe(OrderStatus.Active);
  });

  it.each([StepName.UpdateErpStep, StepName.EmailNotificationStep])(
    'executes %s with a stable integration idempotency key',
    async (stepName) => {
      const { registry, logger } = await setup();
      const { context } = activationFixture();
      const kind = stepName === StepName.UpdateErpStep ? 'erp' : 'email';

      jest.useFakeTimers();
      const operation = registry.get(stepName).exec(context);

      await jest.runAllTimersAsync();
      await operation;

      expect(logger.info).toHaveBeenCalledWith(`integration.${kind}.accepted`, {
        order_id: context.order.id,
        idempotency_key: `${context.order.id}:${kind}`,
      });
    },
  );

  it.each(['erp', 'email'] as const)(
    'rejects permanent %s failures',
    async (kind) => {
      const { simulator, logger } = await setup({
        SIMULATOR_PERMANENT_FAILURE: kind,
      });

      const { context } = activationFixture();

      jest.useFakeTimers();

      const outcome = expect(
        simulator.execute(kind, context),
      ).rejects.toBeInstanceOf(PermanentActivationError);

      await jest.runAllTimersAsync();
      await outcome;
      expect(logger.info).not.toHaveBeenCalled();
    },
  );

  it.each(['erp', 'email'] as const)(
    'fails %s through the configured attempt and succeeds on the next one',
    async (kind) => {
      const { simulator } = await setup({ ERP_FAILURES: 2, EMAIL_FAILURES: 2 });
      const { context } = activationFixture();

      jest.useFakeTimers();
      context.event.meta.attempt = 2;

      const rejected = expect(simulator.execute(kind, context)).rejects.toThrow(
        'Simulated transient integration failure',
      );

      await jest.runAllTimersAsync();
      await rejected;
      context.event.meta.attempt = 3;

      const accepted = expect(
        simulator.execute(kind, context),
      ).resolves.toBeUndefined();

      await jest.runAllTimersAsync();
      await accepted;
    },
  );

  it('times out at the configured deadline', async () => {
    const { simulator, logger } = await setup({
      SIMULATOR_DELAY_MS: 101,
      SIMULATOR_TIMEOUT_MS: 100,
    });

    const { context } = activationFixture();

    jest.useFakeTimers();

    const rejected = expect(
      simulator.execute('erp', context),
    ).rejects.toBeInstanceOf(IntegrationTimeoutError);

    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('accepts a delay equal to the timeout boundary', async () => {
    const { simulator } = await setup({
      SIMULATOR_DELAY_MS: 100,
      SIMULATOR_TIMEOUT_MS: 100,
    });

    const { context } = activationFixture();

    jest.useFakeTimers();

    const accepted = expect(
      simulator.execute('erp', context),
    ).resolves.toBeUndefined();

    await jest.advanceTimersByTimeAsync(100);
    await accepted;
  });
});
