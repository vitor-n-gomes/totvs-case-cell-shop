import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ProcessingStatus } from '@app/order/domain/shared/types/order.type';
import { OrderRepository } from '../../repositories/order.repository';
import { PermanentActivationError } from './activation-errors';

export type ActivationDecision = 'skip' | 'proceed';

const FINAL_STATUSES = [ProcessingStatus.Completed, ProcessingStatus.Failed];

@Injectable()
export class OrderActivationGuard {
  constructor(private readonly orderRepository: OrderRepository) {}

  async evaluate(
    orderId: string,
    attempt: number,
    entityManager: EntityManager,
  ): Promise<ActivationDecision> {
    const order = await this.orderRepository.findById(orderId, entityManager);

    if (!order) {

      throw new PermanentActivationError('Unknown order');

    }

    if (
      FINAL_STATUSES.includes(order.processingStatus) ||
      attempt <= order.lastAttempt
    ) {

      return 'skip';

    }

    if (attempt !== order.lastAttempt + 1) {

      throw new PermanentActivationError('Out-of-sequence attempt');

    }

    return 'proceed';
  }
}
