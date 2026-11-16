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
    manager: EntityManager,
    orderId: string,
    items: { productId: string; quantity: number }[],
    ttl: number,
  ): Promise<ReservedItem[]> {
    const reserved: ReservedItem[] = [];

    for (const item of [...items].sort((a, b) =>
      a.productId.localeCompare(b.productId),
    )) {

      const product = await manager
        .getRepository(ProductEntity)
        .findOneBy({ id: item.productId });

      if (!product) {

        throw new NotFoundException('Product not found');

      }

      const result = await manager
        .getRepository(StockEntity)
        .createQueryBuilder()
        .update()
        .set({ reservedQuantity: () => 'reserved_quantity + :quantity' })
        .where('product_id = :productId', { productId: item.productId })
        .andWhere('physical_quantity - reserved_quantity >= :quantity', {
          quantity: item.quantity,
        })
        .execute();

      if (!result.affected) {

        throw new ConflictException('Insufficient stock');

      }

      await manager
        .getRepository(ReservationEntity)
        .createQueryBuilder()
        .insert()
        .values({
          id: randomUUID(),
          orderId,
          productId: item.productId,
          quantity: item.quantity,
          status: 'ACTIVE',
          expiresAt: () => "clock_timestamp() + :ttl * interval '1 second'",
        })
        .setParameter('ttl', ttl)
        .execute();

      reserved.push({
        ...item,
        netPrice: product.netPrice,
        listPrice: product.listPrice,
      });

    }

    return reserved;
  }
}
