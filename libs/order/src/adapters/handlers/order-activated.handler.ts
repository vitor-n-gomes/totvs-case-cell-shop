import { Injectable } from '@nestjs/common';
import {
  ORDER_ACTIVATED,
  OrderActivatedEvent,
} from '@app/order/messaging/order-events';
import { EventHandler } from './event.handler';
import { AppLogger } from '@app/platform/logging/app-logger';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { Metrics } from '@app/platform/observability/metrics';

/**
 * Handler for order activation events
 * Processes events when an order is activated and tracks metrics
 */
@Injectable()
export class OrderActivatedHandler implements EventHandler<OrderActivatedEvent> {
  readonly kind = ORDER_ACTIVATED;

  constructor(
    private readonly logger: AppLogger,
    private readonly orderRepository: OrderRepository,
    private readonly metrics: Metrics,
  ) {}

  async handle(event: OrderActivatedEvent): Promise<void> {
    const orderId = event.data.order_id;

    this.logger.info('order.activated.handler.processing', {
      order_id: orderId,
    });

    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      this.logger.error('order.activated.handler.order_not_found', {
        order_id: orderId,
      });

      return;
    }

    this.metrics.reservations.inc({ result: 'activated' });
  }
}
