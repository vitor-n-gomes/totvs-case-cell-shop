import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ReservationEntity } from '../entities';
import {
  PermanentActivationError,
  ReservationExpiredError,
} from '../activation/guards/activation-errors';

@Injectable()
export class ReservationRepository {
  private lock(
    manager: EntityManager,
    orderId: string,
  ): Promise<ReservationEntity[]> {
    return manager
      .getRepository(ReservationEntity)
      .createQueryBuilder('reservation')
      .where('reservation.order_id = :orderId', { orderId })
      .orderBy('reservation.product_id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
  }
  async consume(manager: EntityManager, orderId: string): Promise<number> {
    const reservations = await this.lock(manager, orderId);
    if (
      !reservations.length ||
      reservations.some((entry) => entry.status !== 'ACTIVE')
    )
      throw new PermanentActivationError('No active reservation');
    const [result]: { expired: boolean }[] = await manager.query(
      'SELECT EXISTS(SELECT 1 FROM stock_reservation WHERE order_id=$1 AND expires_at<=clock_timestamp()) AS expired',
      [orderId],
    );
    if (result?.expired)
      throw new ReservationExpiredError('Reservation expired');
    for (const reservation of reservations) {
      const [affected]: [{ id: string }[], number] = await manager.query(
        `UPDATE stock SET physical_quantity=physical_quantity-$2,reserved_quantity=reserved_quantity-$2
        WHERE product_id=$1 AND reserved_quantity >= $2 AND physical_quantity >= $2 RETURNING id`,
        [reservation.productId, reservation.quantity],
      );
      if (!affected.length)
        throw new PermanentActivationError('Stock invariant violated');
    }
    await manager.query(
      "UPDATE stock_reservation SET status='CONSUMED' WHERE order_id=$1",
      [orderId],
    );
    return reservations.length;
  }
  /** Caller holds the order row lock. Only still-active reservations are released. */
  async release(manager: EntityManager, orderId: string): Promise<number> {
    const reservations = await this.lock(manager, orderId);
    let released = 0;
    for (const entry of reservations.filter(
      (item) => item.status === 'ACTIVE',
    )) {
      const [affected]: [{ id: string }[], number] = await manager.query(
        'UPDATE stock SET reserved_quantity=reserved_quantity-$2 WHERE product_id=$1 AND reserved_quantity >= $2 RETURNING id',
        [entry.productId, entry.quantity],
      );
      if (!affected.length)
        throw new PermanentActivationError('Stock invariant violated');
      await manager.query(
        "UPDATE stock_reservation SET status='EXPIRED' WHERE id=$1",
        [entry.id],
      );
      released++;
    }
    return released;
  }
}
