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
    entityManager: EntityManager,
    orderId: string,
    stepName: StepName,
  ): Promise<boolean> {
    return entityManager.getRepository(IdempotencyLogEntity).existsBy({
      orderId,
      action: ACTIVATION_ACTION,
      step: stepName,
      success: true,
    });
  }

  async record(
    entityManager: EntityManager,
    orderId: string,
    stepName: StepName,
    success: boolean,
    stepReference: Record<string, unknown>,
    description: string,
  ): Promise<void> {
    await entityManager
      .getRepository(IdempotencyLogEntity)
      .createQueryBuilder()
      .insert()
      .values({
        id: randomUUID(),
        orderId,
        action: ACTIVATION_ACTION,
        step: stepName,
        success,
        reference: () => ':reference',
        description,
      })
      .setParameter('reference', JSON.stringify(stepReference))
      .orIgnore()
      .execute();
  }
}
