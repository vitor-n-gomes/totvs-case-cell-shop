import { OrderRepository } from '@app/order/repositories/order.repository';
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class GetOrderStatusUseCase {
  
  constructor(private readonly orders: OrderRepository) {}

  async execute(orderId: string) {

    const order = await this.orders.findById(orderId);

    if (!order) throw new NotFoundException('Order not found');

    const items = await this.orders.findItems(orderId);

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
