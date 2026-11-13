import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  ACTIVATION_ACTION,
  StepName,
} from '../activation/constants/step-names';
import { IdempotencyLogEntity } from '../domain/entities';
@Injectable()
export class IdempotencyLogRepository {
  succeeded(
    manager: EntityManager,
    orderId: string,
    step: StepName,
  ): Promise<boolean> {
    return manager
      .getRepository(IdempotencyLogEntity)
      .existsBy({ orderId, action: ACTIVATION_ACTION, step, success: true });
  }

  async record(
    manager: EntityManager,
    orderId: string,
    step: StepName,
    success: boolean,
    reference: Record<string, unknown>,
    description: string,
  ): Promise<void> {
    await manager
      .getRepository(IdempotencyLogEntity)
      .createQueryBuilder()
      .insert()
      .values({
        id: randomUUID(),
        orderId,
        action: ACTIVATION_ACTION,
        step,
        success,
        reference: () => ':reference',
        description,
      })
      .setParameter('reference', JSON.stringify(reference))
      .orIgnore()
      .execute();
  }
}
