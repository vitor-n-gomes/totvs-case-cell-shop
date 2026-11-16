import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OrderRepository } from '@app/orders/repositories/order.repository';
import { OrderEntity, OrderItemEntity } from '@app/orders/domain/entities';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/orders/domain/shared/types/order.type';
import {
  checkoutPayload,
  orderFixture,
  transactionRunner,
} from './support/fixtures';
import { queryBuilderMock } from './support/query-builder';

describe('OrderRepository', () => {
  async function setup() {
    const { runner: transaction } = transactionRunner();

    const runner = {
      ...transaction,
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const builder = queryBuilderMock();

    const repository = {
      create: jest.fn((value: object) => value),
      createQueryBuilder: jest.fn(() => builder),
      findOneBy: jest.fn(),
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const defaultRepository = { findOneBy: jest.fn() };
    const itemRepository = { find: jest.fn().mockResolvedValue([]) };

    const manager = {
      getRepository: jest.fn(() => repository),
    } as unknown as EntityManager;

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderRepository,
        { provide: DataSource, useValue: { createQueryRunner: () => runner } },
        {
          provide: getRepositoryToken(OrderEntity),
          useValue: defaultRepository,
        },
        {
          provide: getRepositoryToken(OrderItemEntity),
          useValue: itemRepository,
        },
      ],
    }).compile();

    return {
      service: moduleRef.get(OrderRepository),
      builder,
      repository,
      defaultRepository,
      itemRepository,
      manager,
      runner,
    };
  }

  it.each([true, false])(
    'reports whether an idempotent insert created a new row: %s',
    async (inserted) => {
      const { service, builder, manager } = await setup();
      const payload = checkoutPayload();

      builder.execute.mockResolvedValue({
        raw: inserted ? [{ id: 'order' }] : [],
        affected: 0,
      });

      await expect(
        service.insertPending(
          manager,
          'order',
          payload,
          'key',
          'hash',
          'correlation',
        ),
      ).resolves.toBe(inserted);

      expect(builder.values).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'order',
          idempotencyKey: 'key',
          requestHash: 'hash',
          correlationId: 'correlation',
          paymentMethod: payload.paymentMethod,
        }),
      );

      expect(builder.orIgnore).toHaveBeenCalled();
    },
  );

  it('uses the transaction repository for idempotency lookup', async () => {
    const { service, repository, manager } = await setup();
    const order = orderFixture();

    repository.findOneBy.mockResolvedValue(order);
    await expect(service.findByKey(manager, 'key')).resolves.toBe(order);

    expect(repository.findOneBy).toHaveBeenCalledWith({
      idempotencyKey: 'key',
    });
  });

  it.each([true, false])(
    'reads by id using a transaction only when provided: %s',
    async (inTransaction) => {
      const { service, repository, defaultRepository, manager } = await setup();
      const order = orderFixture();
      const selected = inTransaction ? repository : defaultRepository;
      const other = inTransaction ? defaultRepository : repository;

      selected.findOneBy.mockResolvedValue(order);

      await expect(
        service.findById(order.id, inTransaction ? manager : undefined),
      ).resolves.toBe(order);

      expect(selected.findOneBy).toHaveBeenCalledWith({ id: order.id });
      expect(other.findOneBy).not.toHaveBeenCalled();
    },
  );

  it('returns order items in deterministic product order', async () => {
    const { service, itemRepository } = await setup();

    await expect(service.findItems('order')).resolves.toEqual([]);

    expect(itemRepository.find).toHaveBeenCalledWith({
      where: { orderId: 'order' },
      order: { productId: 'ASC' },
    });
  });

  it('uses a write lock and preserves missing-order semantics', async () => {
    const { service, repository, manager } = await setup();
    const missing = new Error('entity not found');

    repository.findOne.mockResolvedValue(null);
    repository.findOneOrFail.mockRejectedValue(missing);
    await expect(service.lock(manager, 'missing')).resolves.toBeNull();
    await expect(service.lockOrFail(manager, 'missing')).rejects.toBe(missing);

    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: 'missing' },
      lock: { mode: 'pessimistic_write' },
    });

    expect(repository.findOneOrFail).toHaveBeenCalledWith({
      where: { id: 'missing' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('assigns independent item ids and retains the price snapshot without mutating input', async () => {
    const { service, repository, manager } = await setup();

    const items = [
      { productId: 'one', quantity: 2, netPrice: 1000, listPrice: 1500 },
      { productId: 'two', quantity: 1, netPrice: 2000, listPrice: 2500 },
    ];

    const snapshot = structuredClone(items);

    await service.addItems(manager, 'order', items);
    const saved = repository.insert.mock.calls[0]![0];

    expect(saved).toEqual(
      items.map((item) => ({
        ...item,
        orderId: 'order',
        id: expect.any(String),
      })),
    );

    expect(saved[0].id).not.toBe(saved[1].id);
    expect(items).toEqual(snapshot);
  });

  it('updates only the targeted order', async () => {
    const { service, repository, manager } = await setup();

    await service.update(manager, 'order', {
      processingStatus: ProcessingStatus.Retrying,
      lastAttempt: 2,
    });

    expect(repository.update).toHaveBeenCalledWith(
      { id: 'order' },
      { processingStatus: ProcessingStatus.Retrying, lastAttempt: 2 },
    );
  });

  it.each([0, 1, undefined])(
    'returns a safe affected count for conditional status transitions: %p',
    async (affected) => {
      const { service, builder, manager } = await setup();

      builder.execute.mockResolvedValue({ raw: [], affected });

      await expect(
        service.transitionStatus(
          manager,
          'order',
          [OrderStatus.Pending],
          OrderStatus.Cancelled,
        ),
      ).resolves.toBe(affected ?? 0);

      expect(builder.where).toHaveBeenCalledWith('id = :id', { id: 'order' });

      expect(builder.andWhere).toHaveBeenCalledWith('status IN (:...from)', {
        from: [OrderStatus.Pending],
      });
    },
  );

  it('returns the operation result and releases the advisory lock and connection', async () => {
    const { service, runner } = await setup();

    await expect(
      service.withActivationLock('order', async () => 'result'),
    ).resolves.toBe('result');

    expect(runner.query.mock.calls).toEqual([
      ['SELECT pg_advisory_lock(hashtextextended($1,0))', ['order']],
      ['SELECT pg_advisory_unlock(hashtextextended($1,0))', ['order']],
    ]);

    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back an active transaction after an operation failure before releasing the session', async () => {
    const { service, runner } = await setup();
    const failure = new Error('activation failed');

    runner.isTransactionActive = true;

    await expect(
      service.withActivationLock('order', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);

    expect(runner.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      runner.query.mock.invocationCallOrder[1]!,
    );

    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it.each(['connect', 'query'] as const)(
    'releases the connection without unlocking when %s fails before acquiring the lock',
    async (method) => {
      const { service, runner } = await setup();
      const failure = new Error('database down');
      const operation = jest.fn();

      runner[method].mockRejectedValueOnce(failure);

      await expect(service.withActivationLock('order', operation)).rejects.toBe(
        failure,
      );

      expect(operation).not.toHaveBeenCalled();
      expect(runner.query).toHaveBeenCalledTimes(method === 'connect' ? 0 : 1);
      expect(runner.release).toHaveBeenCalledTimes(1);
    },
  );

  it('releases the connection even when unlocking fails', async () => {
    const { service, runner } = await setup();
    const failure = new Error('unlock failed');

    runner.query.mockResolvedValueOnce([]).mockRejectedValueOnce(failure);

    await expect(
      service.withActivationLock('order', async () => undefined),
    ).rejects.toBe(failure);

    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});
