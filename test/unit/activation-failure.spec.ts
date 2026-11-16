import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ActivationFailureHandler } from '@app/order/activation/handlers/activation-failure.handler';
import { PermanentActivationError } from '@app/order/activation/guards/activation-errors';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { IdempotencyLogRepository } from '@app/order/repositories/idempotency-log.repository';
import { OutboxRepository } from '@app/order/repositories/outbox.repository';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';
import { parseOrderEvent } from '@app/order/messaging/order-events';
import { ReservationRepository } from '@app/products/inventory/repositories/reservation.repository';
import { AppLogger } from '@app/platform/logging/app-logger';
import { Metrics } from '@app/platform/observability/metrics';
import { activationFixture, loggerMock } from './support/fixtures';

describe('ActivationFailureHandler', () => {
  async function setup() {
    const fixture = activationFixture();

    const repository = {
      lockOrFail: jest.fn().mockResolvedValue(fixture.order),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const journal = { record: jest.fn().mockResolvedValue(undefined) };
    const outbox = { append: jest.fn().mockResolvedValue(undefined) };
    const reservations = { release: jest.fn().mockResolvedValue(1) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ActivationFailureHandler,
        Metrics,
        { provide: OrderRepository, useValue: repository },
        { provide: IdempotencyLogRepository, useValue: journal },
        { provide: OutboxRepository, useValue: outbox },
        { provide: ReservationRepository, useValue: reservations },
        {
          provide: ConfigService,
          useValue: new ConfigService({ CHECKOUT_TOPIC: 'checkout' }),
        },
        { provide: AppLogger, useValue: loggerMock() },
      ],
    }).compile();

    return {
      ...fixture,
      service: moduleRef.get(ActivationFailureHandler),
      repository,
      journal,
      outbox,
      reservations,
      metric: jest.spyOn(moduleRef.get(Metrics).processingCounter, 'inc'),
    };
  }

  it.each([1, 2, 3, 4])(
    'schedules attempt %s with exponential backoff and keeps stock reserved',
    async (attempt) => {
      const {
        service,
        context,
        queryRunner,
        runner,
        order,
        repository,
        journal,
        outbox,
        reservations,
        metric,
      } = await setup();

      context.event.meta.attempt = attempt;

      await service.handle(
        queryRunner,
        order,
        context,
        new Error('temporary failure'),
      );

      expect(repository.update).toHaveBeenCalledWith(runner.manager, order.id, {
        processingStatus: ProcessingStatus.Retrying,
        lastAttempt: attempt,
      });

      expect(journal.record).toHaveBeenCalledWith(
        runner.manager,
        order.id,
        context.currentStep,
        false,
        expect.objectContaining({ error_type: 'Error', attempt }),
        'Failed; retry scheduled',
      );

      expect(outbox.append).toHaveBeenCalledWith(
        runner.manager,
        order.id,
        'checkout',
        expect.objectContaining({
          meta: expect.objectContaining({
            attempt: attempt + 1,
            correlation_id: context.event.meta.correlation_id,
          }),
        }),
        `${order.id}:attempt:${attempt + 1}`,
        2 ** (attempt - 1),
      );

      expect(parseOrderEvent(outbox.append.mock.calls[0]![3])).not.toBeNull();

      expect(outbox.append.mock.calls[0]![3].meta.event_id).not.toBe(
        context.event.meta.event_id,
      );

      expect(reservations.release).not.toHaveBeenCalled();
      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(metric).toHaveBeenCalledWith({ result: 'retry' });
    },
  );

  it.each([
    new PermanentActivationError('rejected'),
    new Error('attempt limit'),
  ])(
    'dead-letters a terminal pending order and releases reservations',
    async (failure) => {
      const {
        service,
        context,
        queryRunner,
        runner,
        order,
        repository,
        outbox,
        reservations,
        metric,
      } = await setup();

      context.event.meta.attempt =
        failure instanceof PermanentActivationError ? 1 : 5;

      await service.handle(queryRunner, order, context, failure);

      expect(reservations.release).toHaveBeenCalledWith(
        runner.manager,
        order.id,
      );

      expect(repository.update).toHaveBeenCalledWith(runner.manager, order.id, {
        status: OrderStatus.Cancelled,
      });

      expect(repository.update).toHaveBeenCalledWith(runner.manager, order.id, {
        processingStatus: ProcessingStatus.Failed,
        lastAttempt: context.event.meta.attempt,
      });

      expect(outbox.append).toHaveBeenCalledWith(
        runner.manager,
        order.id,
        'checkout.dlq',
        expect.objectContaining({
          meta: expect.objectContaining({
            attempt: context.event.meta.attempt,
          }),
        }),
        `${order.id}:dlq:${context.event.meta.attempt}`,
        0,
      );

      expect(metric).toHaveBeenCalledWith({ result: 'dlq' });
    },
  );

  it.each([OrderStatus.Active, OrderStatus.Cancelled])(
    'does not release stock or change business status for a terminal %s order',
    async (status) => {
      const { service, context, queryRunner, order, reservations, repository } =
        await setup();

      order.status = status;

      await service.handle(
        queryRunner,
        order,
        context,
        new PermanentActivationError('rejected'),
      );

      expect(reservations.release).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledTimes(1);

      expect(repository.update).toHaveBeenCalledWith(
        queryRunner.manager,
        order.id,
        { processingStatus: ProcessingStatus.Failed, lastAttempt: 1 },
      );
    },
  );

  it('records non-Error failures without exposing their contents', async () => {
    const { service, context, queryRunner, order, journal } = await setup();

    await service.handle(
      queryRunner,
      order,
      context,
      'secret upstream response',
    );

    expect(journal.record).toHaveBeenCalledWith(
      queryRunner.manager,
      order.id,
      context.currentStep,
      false,
      {
        error_type: 'UnknownError',
        attempt: 1,
        event_id: context.event.meta.event_id,
      },
      'Failed; retry scheduled',
    );
  });

  it('rolls back when scheduling fails and does not count a successful retry', async () => {
    const { service, context, queryRunner, runner, order, outbox, metric } =
      await setup();

    const failure = new Error('outbox unavailable');

    outbox.append.mockRejectedValue(failure);

    await expect(
      service.handle(
        queryRunner,
        order,
        context,
        new Error('integration failed'),
      ),
    ).rejects.toBe(failure);

    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(metric).not.toHaveBeenCalled();
  });

  it('does not roll back an already closed transaction after commit failure', async () => {
    const { service, context, queryRunner, runner, order, metric } =
      await setup();

    const failure = new Error('commit acknowledgement lost');

    runner.commitTransaction.mockImplementation(async () => {
      runner.isTransactionActive = false;

      throw failure;
    });

    await expect(
      service.handle(
        queryRunner,
        order,
        context,
        new Error('integration failed'),
      ),
    ).rejects.toBe(failure);

    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(metric).not.toHaveBeenCalled();
  });
});
