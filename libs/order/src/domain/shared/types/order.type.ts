import type { CheckoutInput } from '@app/contracts';
import type { OrderEntity } from '../../entities/order.entity';
export type PaymentType = CheckoutInput['paymentType'];
export type Environment = CheckoutInput['environment'];
export type OrderStatus = OrderEntity['status'];
export type ProcessingStatus = OrderEntity['processingStatus'];
