import { Injectable } from '@nestjs/common';
import { OrderEvent } from '@app/order/domain/events';
import { EventHandler } from './event.handler';
import { AppLogger } from '@app/platform/logging/app-logger';
import { OrderRepository } from '@app/order/repositories/order.repository';
import { Metrics } from '@app/platform/observability/metrics';

/**
 * Handler for order activation events
 * Processes events when an order is activated and tracks metrics
 */
@Injectable()
export class OrderActivatedHandler implements EventHandler<{ orderId: string }> {
  kind = 'order.activated';

  constructor(
    private readonly logger: AppLogger,
    private readonly orderRepository: OrderRepository,
    private readonly metrics: Metrics,
  ) {}

  async handle(
    event: OrderEvent<{ orderId: string }>,
  ): Promise<void> {
    const { orderId } = event.data;
    const { correlationId } = event.meta;

    this.logger.info('order.activated.handler.processing', {
      orderId,
      correlationId,
    });

    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      this.logger.error('order.activated.handler.order_not_found', {
        orderId,
        correlationId,
      });
      return;
    }

    this.metrics.reservations.inc({ result: 'activated' });
  }
}
