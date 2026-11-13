import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';
import { CheckoutInput } from '@app/contracts';
import { OrderEntity, OrderItemEntity } from '../domain/entities';

type OrderItemInput = Pick<
  OrderItemEntity,
  'productId' | 'quantity' | 'netPrice' | 'listPrice'
>;
type OrderColumns = Omit<
  OrderEntity,
  'items' | 'reservations' | 'idempotencyLogs' | 'outboxEvents'
>;
type OrderChanges = Partial<
  Pick<OrderEntity, 'status' | 'processingStatus' | 'lastAttempt'>
>;

@Injectable()
export class OrderRepository {
  constructor(
    private readonly database: DataSource,
    @InjectRepository(OrderEntity)
    private readonly orders: Repository<OrderEntity>,
    @InjectRepository(OrderItemEntity)
    private readonly items: Repository<OrderItemEntity>,
  ) {}

  async insertPending(
    manager: EntityManager,
    id: string,
    input: CheckoutInput,
    idempotencyKey: string,
    requestHash: string,
    correlationId: string,
  ): Promise<boolean> {
    const details: OrderColumns = manager
      .getRepository(OrderEntity)
      .create(input);
    const result = await manager
      .getRepository(OrderEntity)
      .createQueryBuilder()
      .insert()
      .values({
        ...details,
        altContact: input.altContact,
        id,
        idempotencyKey,
        requestHash,
        correlationId,
      })
      .orIgnore()
      .returning(['id'])
      .execute();
    return (result.raw as { id: string }[]).length > 0;
  }

  findByKey(
    manager: EntityManager,
    idempotencyKey: string,
  ): Promise<OrderEntity | null> {
    return manager.getRepository(OrderEntity).findOneBy({ idempotencyKey });
  }

  findById(id: string, manager?: EntityManager): Promise<OrderEntity | null> {
    return (manager?.getRepository(OrderEntity) ?? this.orders).findOneBy({
      id,
    });
  }

  findItems(orderId: string): Promise<OrderItemEntity[]> {
    return this.items.find({ where: { orderId }, order: { productId: 'ASC' } });
  }

  lock(manager: EntityManager, id: string): Promise<OrderEntity | null> {
    return manager
      .getRepository(OrderEntity)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }

  async lockOrFail(manager: EntityManager, id: string): Promise<OrderEntity> {
    return manager
      .getRepository(OrderEntity)
      .findOneOrFail({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }

  async addItems(
    manager: EntityManager,
    orderId: string,
    items: OrderItemInput[],
  ): Promise<void> {
    await manager
      .getRepository(OrderItemEntity)
      .insert(items.map((item) => ({ ...item, orderId, id: randomUUID() })));
  }

  async update(
    manager: EntityManager,
    id: string,
    changes: OrderChanges,
  ): Promise<void> {
    await manager.getRepository(OrderEntity).update({ id }, changes);
  }

  // A session lock spans the local transaction and the external activation steps.
  async withActivationLock<T>(
    id: string,
    work: (runner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const runner = this.database.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      await runner.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        id,
      ]);
      locked = true;
      return await work(runner);
    } finally {
      try {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        if (locked)
          await runner.query(
            'SELECT pg_advisory_unlock(hashtextextended($1,0))',
            [id],
          );
      } finally {
        await runner.release();
      }
    }
  }
}
