import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ReservationEntity, StockEntity } from '../domain/entities';
import {
  InventoryError,
  ReservationExpiredError,
} from '../domain/errors/inventory-errors';

@Injectable()
export class ReservationRepository {
  constructor(
    @InjectRepository(ReservationEntity)
    private readonly reservations: Repository<ReservationEntity>,
  ) {}

  private lock(
    manager: EntityManager,
    orderId: string,
  ): Promise<ReservationEntity[]> {
    return manager
      .getRepository(ReservationEntity)
      .createQueryBuilder('reservation')
      .where('reservation.orderId = :orderId', { orderId })
      .orderBy('reservation.productId', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
  }

  /** Oldest-first page of orders still in one of `orderStatuses` holding an expired active reservation. */
  async expiredOrderIds(
    orderStatuses: readonly string[],
    limit: number,
  ): Promise<string[]> {
    const rows = await this.reservations
      .createQueryBuilder('reservation')
      .innerJoin('reservation.order', 'order')
      .select('reservation.orderId', 'order_id')
      .where('reservation.status = :status', { status: 'ACTIVE' })
      .andWhere('reservation.expiresAt < NOW()')
      .andWhere('order.status IN (:...orderStatuses)', {
        orderStatuses: [...orderStatuses],
      })
      .groupBy('reservation.orderId')
      .orderBy('MIN(reservation.expiresAt)', 'ASC')
      .limit(limit)
      .getRawMany<{ order_id: string }>();

    return rows.map((row) => row.order_id);
  }

  hasExpired(manager: EntityManager, orderId: string): Promise<boolean> {
    return manager
      .getRepository(ReservationEntity)
      .createQueryBuilder('reservation')
      .where('reservation.orderId = :orderId', { orderId })
      .andWhere('reservation.status = :status', { status: 'ACTIVE' })
      .andWhere('reservation.expiresAt <= clock_timestamp()')
      .getExists();
  }

  async consume(manager: EntityManager, orderId: string): Promise<number> {
    const reservations = await this.lock(manager, orderId);

    if (
      !reservations.length ||
      reservations.some((entry) => entry.status !== 'ACTIVE')
    )
      throw new InventoryError('No active reservation');

    if (await this.hasExpired(manager, orderId))
      throw new ReservationExpiredError('Reservation expired');

    for (const entry of reservations) {
      const result = await manager
        .getRepository(StockEntity)
        .createQueryBuilder()
        .update()
        .set({
          physicalQuantity: () => 'physical_quantity - :quantity',
          reservedQuantity: () => 'reserved_quantity - :quantity',
        })
        .where('product_id = :productId', { productId: entry.productId })
        .andWhere(
          'reserved_quantity >= :quantity AND physical_quantity >= :quantity',
          { quantity: entry.quantity },
        )
        .execute();

      if (!result.affected)
        throw new InventoryError('Stock invariant violated');
    }

    await manager
      .getRepository(ReservationEntity)
      .update({ orderId }, { status: 'CONSUMED' });

    return reservations.length;
  }
  // Caller holds the order row lock. Release only reservations that are still active.
  async release(manager: EntityManager, orderId: string): Promise<number> {
    const reservations = await this.lock(manager, orderId);
    let released = 0;

    for (const entry of reservations.filter(
      (item) => item.status === 'ACTIVE',
    )) {
      const result = await manager
        .getRepository(StockEntity)
        .createQueryBuilder()
        .update()
        .set({ reservedQuantity: () => 'reserved_quantity - :quantity' })
        .where('product_id = :productId', { productId: entry.productId })
        .andWhere('reserved_quantity >= :quantity', {
          quantity: entry.quantity,
        })
        .execute();

      if (!result.affected)
        throw new InventoryError('Stock invariant violated');

      await manager
        .getRepository(ReservationEntity)
        .update({ id: entry.id }, { status: 'EXPIRED' });

      released++;
    }

    return released;
  }
}
