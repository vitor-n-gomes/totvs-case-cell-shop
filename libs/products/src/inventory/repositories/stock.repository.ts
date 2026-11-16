import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { ProductEntity } from '@app/products/domain/entities';
import { ReservationEntity, StockEntity } from '../domain/entities';

export interface ReservedItem {
  productId: string;
  quantity: number;
  netPrice: number;
  listPrice: number;
}

@Injectable()
export class StockRepository {
  async reserve(
    entityManager: EntityManager,
    orderId: string,
    checkoutItems: { productId: string; quantity: number }[],
    reservationTtlSeconds: number,
  ): Promise<ReservedItem[]> {
    const reservedItems: ReservedItem[] = [];

    for (const checkoutItem of [...checkoutItems].sort((leftItem, rightItem) =>
      leftItem.productId.localeCompare(rightItem.productId),
    )) {

      const product = await entityManager
        .getRepository(ProductEntity)
        .findOneBy({ id: checkoutItem.productId });

      if (!product) {

        throw new NotFoundException('Product not found');

      }

      const stockUpdateResult = await entityManager
        .getRepository(StockEntity)
        .createQueryBuilder()
        .update()
        .set({ reservedQuantity: () => 'reserved_quantity + :quantity' })
        .where('product_id = :productId', { productId: checkoutItem.productId })
        .andWhere('physical_quantity - reserved_quantity >= :quantity', {
          quantity: checkoutItem.quantity,
        })
        .execute();

      if (!stockUpdateResult.affected) {

        throw new ConflictException('Insufficient stock');

      }

      await entityManager
        .getRepository(ReservationEntity)
        .createQueryBuilder()
        .insert()
        .values({
          id: randomUUID(),
          orderId,
          productId: checkoutItem.productId,
          quantity: checkoutItem.quantity,
          status: 'ACTIVE',
          expiresAt: () => "clock_timestamp() + :ttl * interval '1 second'",
        })
        .setParameter('ttl', reservationTtlSeconds)
        .execute();

      reservedItems.push({
        ...checkoutItem,
        netPrice: product.netPrice,
        listPrice: product.listPrice,
      });

    }

    return reservedItems;
  }
}
