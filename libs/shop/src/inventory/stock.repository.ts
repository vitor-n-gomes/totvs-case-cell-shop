import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { CheckoutInput } from '@app/contracts';
import { OrderItemEntity, ProductEntity } from '../entities';

@Injectable()
export class StockRepository {
  async reserve(
    manager: EntityManager,
    orderId: string,
    items: CheckoutInput['items'],
    ttl: number,
  ): Promise<void> {
    for (const item of [...items].sort((a, b) =>
      a.productId.localeCompare(b.productId),
    )) {
      const product = await manager.findOneBy(ProductEntity, {
        id: item.productId,
      });
      if (!product) throw new NotFoundException('Product not found');
      const [stock]: [{ id: string }[], number] = await manager.query(
        'UPDATE stock SET reserved_quantity = reserved_quantity + $2 WHERE product_id = $1 AND physical_quantity - reserved_quantity >= $2 RETURNING id',
        [item.productId, item.quantity],
      );
      if (!stock.length) throw new ConflictException('Insufficient stock');
      await manager.insert(OrderItemEntity, {
        id: randomUUID(),
        orderId,
        productId: item.productId,
        quantity: item.quantity,
        netPrice: product.netPrice,
        listPrice: product.listPrice,
      });
      await manager.query(
        "INSERT INTO stock_reservation (id, order_id, product_id, quantity, status, expires_at) VALUES ($1,$2,$3,$4,'ACTIVE',clock_timestamp() + $5 * interval '1 second')",
        [randomUUID(), orderId, item.productId, item.quantity, ttl],
      );
    }
  }
}
