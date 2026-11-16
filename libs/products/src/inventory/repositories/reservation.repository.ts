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
    private readonly reservationTypeOrmRepository: Repository<ReservationEntity>,
  ) {}

  private lock(
    entityManager: EntityManager,
    orderId: string,
  ): Promise<ReservationEntity[]> {
    return entityManager
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
    batchSize: number,
  ): Promise<string[]> {
    const expiredOrderRows = await this.reservationTypeOrmRepository
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
      .limit(batchSize)
      .getRawMany<{ order_id: string }>();

    return expiredOrderRows.map((expiredOrderRow) => expiredOrderRow.order_id);
  }

  hasExpired(entityManager: EntityManager, orderId: string): Promise<boolean> {
    return entityManager
      .getRepository(ReservationEntity)
      .createQueryBuilder('reservation')
      .where('reservation.orderId = :orderId', { orderId })
      .andWhere('reservation.status = :status', { status: 'ACTIVE' })
      .andWhere('reservation.expiresAt <= clock_timestamp()')
      .getExists();
  }

  async consume(
    entityManager: EntityManager,
    orderId: string,
  ): Promise<number> {
    const reservations = await this.lock(entityManager, orderId);

    if (
      !reservations.length ||
      reservations.some((reservation) => reservation.status !== 'ACTIVE')
    ) {

      throw new InventoryError('No active reservation');

    }

    if (await this.hasExpired(entityManager, orderId)) {

      throw new ReservationExpiredError('Reservation expired');

    }

    for (const reservation of reservations) {

      const stockUpdateResult = await entityManager
        .getRepository(StockEntity)
        .createQueryBuilder()
        .update()
        .set({
          physicalQuantity: () => 'physical_quantity - :quantity',
          reservedQuantity: () => 'reserved_quantity - :quantity',
        })
        .where('product_id = :productId', { productId: reservation.productId })
        .andWhere(
          'reserved_quantity >= :quantity AND physical_quantity >= :quantity',
          { quantity: reservation.quantity },
        )
        .execute();

      if (!stockUpdateResult.affected) {

        throw new InventoryError('Stock invariant violated');

      }

    }

    await entityManager
      .getRepository(ReservationEntity)
      .update({ orderId }, { status: 'CONSUMED' });

    return reservations.length;
  }
  // Caller holds the order row lock. Release only reservations that are still active.
  async release(
    entityManager: EntityManager,
    orderId: string,
  ): Promise<number> {
    const reservations = await this.lock(entityManager, orderId);
    let releasedReservationCount = 0;

    for (const reservation of reservations.filter(
      (reservation) => reservation.status === 'ACTIVE',
    )) {

      const stockUpdateResult = await entityManager
        .getRepository(StockEntity)
        .createQueryBuilder()
        .update()
        .set({ reservedQuantity: () => 'reserved_quantity - :quantity' })
        .where('product_id = :productId', { productId: reservation.productId })
        .andWhere('reserved_quantity >= :quantity', {
          quantity: reservation.quantity,
        })
        .execute();

      if (!stockUpdateResult.affected) {

        throw new InventoryError('Stock invariant violated');

      }

      await entityManager
        .getRepository(ReservationEntity)
        .update({ id: reservation.id }, { status: 'EXPIRED' });

      releasedReservationCount++;

    }

    return releasedReservationCount;
  }
}
