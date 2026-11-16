import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';
import { CheckoutDto } from '@app/order/domain/dto/create-order.dto';
import { OrderEntity, OrderItemEntity } from '../domain/entities';
import { OrderStatus } from '../domain/shared/types/order.type';

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
    private readonly dataSource: DataSource,
    @InjectRepository(OrderEntity)
    private readonly orderTypeOrmRepository: Repository<OrderEntity>,
    @InjectRepository(OrderItemEntity)
    private readonly orderItemTypeOrmRepository: Repository<OrderItemEntity>,
  ) {}

  async insertPending(
    entityManager: EntityManager,
    orderId: string,
    checkoutDto: CheckoutDto,
    idempotencyKey: string,
    requestHash: string,
    correlationId: string,
  ): Promise<boolean> {
    const orderColumns: OrderColumns = entityManager
      .getRepository(OrderEntity)
      .create(checkoutDto);

    const orderInsertResult = await entityManager
      .getRepository(OrderEntity)
      .createQueryBuilder()
      .insert()
      .values({
        ...orderColumns,
        altContact: checkoutDto.altContact,
        id: orderId,
        idempotencyKey,
        requestHash,
        correlationId,
      })
      .orIgnore()
      .returning(['id'])
      .execute();

    return (orderInsertResult.raw as { id: string }[]).length > 0;
  }

  findByKey(
    entityManager: EntityManager,
    idempotencyKey: string,
  ): Promise<OrderEntity | null> {
    return entityManager
      .getRepository(OrderEntity)
      .findOneBy({ idempotencyKey });
  }

  findById(
    orderId: string,
    entityManager?: EntityManager,
  ): Promise<OrderEntity | null> {
    return (
      entityManager?.getRepository(OrderEntity) ?? this.orderTypeOrmRepository
    ).findOneBy({
      id: orderId,
    });
  }

  findItems(orderId: string): Promise<OrderItemEntity[]> {
    return this.orderItemTypeOrmRepository.find({
      where: { orderId },
      order: { productId: 'ASC' },
    });
  }

  lock(
    entityManager: EntityManager,
    orderId: string,
  ): Promise<OrderEntity | null> {
    return entityManager
      .getRepository(OrderEntity)
      .findOne({ where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
  }

  async lockOrFail(
    entityManager: EntityManager,
    orderId: string,
  ): Promise<OrderEntity> {
    return entityManager.getRepository(OrderEntity).findOneOrFail({
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async addItems(
    entityManager: EntityManager,
    orderId: string,
    orderItems: OrderItemInput[],
  ): Promise<void> {
    await entityManager.getRepository(OrderItemEntity).insert(
      orderItems.map((orderItem) => ({
        ...orderItem,
        orderId,
        id: randomUUID(),
      })),
    );
  }

  async update(
    entityManager: EntityManager,
    orderId: string,
    orderChanges: OrderChanges,
  ): Promise<void> {
    await entityManager
      .getRepository(OrderEntity)
      .update({ id: orderId }, orderChanges);
  }

  /** Conditional status transition; returns the affected row count (0 when `allowedStatuses` no longer matches). */
  async transitionStatus(
    entityManager: EntityManager,
    orderId: string,
    allowedStatuses: readonly OrderStatus[],
    targetStatus: OrderStatus,
  ): Promise<number> {
    const statusUpdateResult = await entityManager
      .getRepository(OrderEntity)
      .createQueryBuilder()
      .update()
      .set({ status: targetStatus })
      .where('id = :id', { id: orderId })
      .andWhere('status IN (:...from)', { from: [...allowedStatuses] })
      .execute();

    return statusUpdateResult.affected ?? 0;
  }

  // A session lock spans the local transaction and the external activation steps.
  async withActivationLock<T>(
    orderId: string,
    activationOperation: (queryRunner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    let isActivationLockHeld = false;

    try {

      await queryRunner.connect();

      await queryRunner.query(
        'SELECT pg_advisory_lock(hashtextextended($1,0))',
        [orderId],
      );

      isActivationLockHeld = true;

      return await activationOperation(queryRunner);

    } finally {

      try {

        if (queryRunner.isTransactionActive) {

          await queryRunner.rollbackTransaction();

        }

        if (isActivationLockHeld) {

          await queryRunner.query(
            'SELECT pg_advisory_unlock(hashtextextended($1,0))',
            [orderId],
          );

        }

      } finally {

        await queryRunner.release();

      }

    }
  }
}
