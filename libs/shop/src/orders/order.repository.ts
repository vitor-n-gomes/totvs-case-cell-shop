import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderEntity, OrderItemEntity } from '../entities';

@Injectable()
export class OrderRepository {
  constructor(private readonly database: DataSource) {}
  async status(orderId: string) {
    const order = await this.database
      .getRepository(OrderEntity)
      .findOneBy({ id: orderId });
    if (!order) throw new NotFoundException('Order not found');
    const items = await this.database
      .getRepository(OrderItemEntity)
      .find({ where: { orderId }, order: { productId: 'ASC' } });
    return {
      orderId: order.id,
      status: order.status,
      processingStatus: order.processingStatus,
      paymentType: order.paymentType,
      paymentMethod: order.paymentMethod,
      dueDate: order.dueDate,
      environment: order.environment,
      createdAt: order.createdAt.toISOString(),
      items: items.map(({ productId, quantity, netPrice, listPrice }) => ({
        productId,
        quantity,
        netPrice,
        listPrice,
      })),
    };
  }
}
