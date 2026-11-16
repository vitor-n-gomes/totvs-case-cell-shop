import {
  OrderStatus,
  ProcessingStatus,
} from '@app/orders/domain/shared/types/order.type';
import { InMemoryStore } from './in-memory-store';

/**
 * Simulates what the Kafka consumer + OnlineActivationStrategy do after the
 * outbox relay delivers `order.checkout.initiated`: consume the reservation,
 * activate the order and complete the (simulated) ERP and e-mail steps.
 *
 * TODO: replace with the real flow by booting ConsumerModule plus the outbox
 * relay against a Kafka testcontainer, then poll GET /orders/:id/status.
 */
export function simulateWorkerProcessing(
  inMemoryStore: InMemoryStore,
  orderId: string,
): void {
  const order = inMemoryStore.orders.get(orderId);

  if (!order) {

    throw new Error(`Order ${orderId} not found`);

  }

  for (const reservation of inMemoryStore.reservations) {

    if (reservation.orderId !== orderId || reservation.status !== 'ACTIVE') {

      continue;

    }

    const product = inMemoryStore.products.get(reservation.productId);

    if (product) {

      product.physicalQuantity -= reservation.quantity;
      product.reservedQuantity -= reservation.quantity;

    }

    reservation.status = 'CONSUMED';

  }

  for (const event of inMemoryStore.outbox) {

    if (event.orderId === orderId) {

      event.status = 'PROCESSED';

    }

  }

  order.status = OrderStatus.Active;
  order.processingStatus = ProcessingStatus.Completed;
}
