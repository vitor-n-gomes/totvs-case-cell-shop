import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  OutboxRepository,
  ClaimedEvent,
} from '@app/orders/repositories/outbox.repository';
import { IdempotencyLogRepository } from '@app/orders/repositories/idempotency-log.repository';
import {
  OutboxEventEntity,
  IdempotencyLogEntity,
} from '@app/orders/domain/entities';
import {
  ACTIVATION_ACTION,
  StepName,
} from '@app/orders/activation/constants/step-names';
import { checkoutEvent } from './support/fixtures';
import { queryBuilderMock } from './support/query-builder';

describe('outbox and idempotency persistence', () => {
  async function setup() {
    const builder = queryBuilderMock();

    const repository = {
      createQueryBuilder: jest.fn(() => builder),
      update: jest.fn().mockResolvedValue(undefined),
      existsBy: jest.fn().mockResolvedValue(false),
    };

    const manager = {
      getRepository: jest.fn(() => repository),
    } as unknown as EntityManager;

    const dataSource = {
      transaction: jest.fn(
        (operation: (manager: EntityManager) => Promise<unknown>) =>
          operation(manager),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboxRepository,
        IdempotencyLogRepository,
        { provide: DataSource, useValue: dataSource },
        {
          provide: getRepositoryToken(OutboxEventEntity),
          useValue: repository,
        },
      ],
    }).compile();

    return {
      outbox: moduleRef.get(OutboxRepository),
      journal: moduleRef.get(IdempotencyLogRepository),
      builder,
      repository,
      manager,
      dataSource,
    };
  }

  function claimed(): ClaimedEvent {
    return {
      id: 'event',
      orderId: 'order',
      topic: 'checkout',
      payload: checkoutEvent(),
      leaseToken: 'current-lease',
    };
  }

  it.each([undefined, 8])(
    'binds event payload and retry delay %p without interpolating JSON into SQL',
    async (delay) => {
      const { outbox, builder, manager } = await setup();
      const payload = { value: "customer's input :payload" };

      await outbox.append(
        manager,
        'order',
        'checkout',
        payload,
        'dedupe-key',
        delay,
      );

      const values = builder.values.mock.calls[0]![0];

      expect(values).toMatchObject({
        id: expect.any(String),
        orderId: 'order',
        topic: 'checkout',
        deduplicationKey: 'dedupe-key',
      });

      expect(values.payload()).toBe(':payload');

      expect(values.availableAt()).toBe(
        "clock_timestamp() + :delay * interval '1 second'",
      );

      expect(builder.setParameter.mock.calls).toEqual([
        ['delay', delay ?? 0],
        ['payload', JSON.stringify(payload)],
      ]);

      expect(builder.orIgnore).toHaveBeenCalledTimes(1);
    },
  );

  it('does not create a lease when no events are due', async () => {
    const { outbox, builder } = await setup();

    await expect(outbox.claim()).resolves.toEqual([]);
    expect(builder.update).not.toHaveBeenCalled();
  });

  it('claims a bounded ordered batch while skipping locks and assigns a shared lease token', async () => {
    const { outbox, builder } = await setup();
    const events = [claimed(), { ...claimed(), id: 'second' }];

    builder.getMany.mockResolvedValue(events);
    const result = await outbox.claim();
    const lease = builder.set.mock.calls[0]![0];

    expect(builder.take).toHaveBeenCalledWith(20);
    expect(builder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(builder.setOnLocked).toHaveBeenCalledWith('skip_locked');
    expect(builder.orderBy).toHaveBeenCalledWith('event.createdAt', 'ASC');
    expect(builder.addOrderBy).toHaveBeenCalledWith('event.id', 'ASC');

    expect(builder.where).toHaveBeenCalledWith('event.status = :status', {
      status: 'PENDING',
    });

    expect(builder.andWhere.mock.calls).toEqual([
      ['event.availableAt <= clock_timestamp()'],
      ['(event.leaseUntil IS NULL OR event.leaseUntil < clock_timestamp())'],
    ]);

    expect(builder.whereInIds).toHaveBeenCalledWith(['event', 'second']);

    expect(lease.leaseUntil()).toBe(
      "clock_timestamp() + interval '30 seconds'",
    );

    expect(result).toEqual(
      events.map((event) => ({ ...event, leaseToken: lease.leaseToken })),
    );

    expect(lease.leaseToken).not.toBe('current-lease');
    expect(events[0]!.leaseToken).toBe('current-lease');
  });

  it('does not return claimed events if persisting the lease fails', async () => {
    const { outbox, builder } = await setup();
    const failure = new Error('lease write failed');

    builder.getMany.mockResolvedValue([claimed()]);
    builder.execute.mockRejectedValue(failure);
    await expect(outbox.claim()).rejects.toBe(failure);
  });

  it('acknowledges only the current lease and clears its lease fields', async () => {
    const { outbox, repository } = await setup();

    await outbox.acknowledge(claimed());

    expect(repository.update).toHaveBeenCalledWith(
      { id: 'event', leaseToken: 'current-lease' },
      { status: 'PROCESSED', leaseToken: null, leaseUntil: null },
    );
  });

  it('conditions release on lease ownership and delays the next delivery', async () => {
    const { outbox, builder } = await setup();

    await outbox.release(claimed());

    expect(builder.where).toHaveBeenCalledWith(
      'id = :id AND lease_token = :leaseToken',
      { id: 'event', leaseToken: 'current-lease' },
    );

    const changes = builder.set.mock.calls[0]![0];

    expect(changes).toMatchObject({ leaseToken: null, leaseUntil: null });

    expect(changes.availableAt()).toBe(
      "clock_timestamp() + interval '1 second'",
    );
  });

  it.each([
    [undefined, { count: 0, ageSeconds: 0 }],
    [
      { count: '3', age: '12.5' },
      { count: 3, ageSeconds: 12.5 },
    ],
    [
      { count: null, age: null },
      { count: 0, ageSeconds: 0 },
    ],
  ])('normalizes backlog aggregate %p', async (row, expected) => {
    const { outbox, builder } = await setup();

    builder.getRawOne.mockResolvedValue(row);
    await expect(outbox.backlog()).resolves.toEqual(expected);

    expect(builder.where).toHaveBeenCalledWith('event.status = :status', {
      status: 'PENDING',
    });
  });

  it.each([true, false])(
    'recognizes only successful records for the same order, action and step: %s',
    async (success) => {
      const { journal, repository, manager } = await setup();

      repository.existsBy.mockResolvedValue(success);

      await expect(
        journal.succeeded(manager, 'order', StepName.UpdateErpStep),
      ).resolves.toBe(success);

      expect(manager.getRepository).toHaveBeenCalledWith(IdempotencyLogEntity);

      expect(repository.existsBy).toHaveBeenCalledWith({
        orderId: 'order',
        action: ACTIVATION_ACTION,
        step: StepName.UpdateErpStep,
        success: true,
      });
    },
  );

  it('stores failure references as bound JSON and tolerates duplicate journal inserts', async () => {
    const { journal, builder, manager } = await setup();
    const reference = { attempt: 2, message: "supplier's :reference" };

    await journal.record(
      manager,
      'order',
      StepName.UpdateErpStep,
      false,
      reference,
      'Failed; retry scheduled',
    );

    const values = builder.values.mock.calls[0]![0];

    expect(values).toMatchObject({
      orderId: 'order',
      action: ACTIVATION_ACTION,
      step: StepName.UpdateErpStep,
      success: false,
      description: 'Failed; retry scheduled',
    });

    expect(values.reference()).toBe(':reference');

    expect(builder.setParameter).toHaveBeenCalledWith(
      'reference',
      JSON.stringify(reference),
    );

    expect(builder.orIgnore).toHaveBeenCalledTimes(1);
  });
});
