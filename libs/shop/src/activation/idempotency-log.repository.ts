import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ACTIVATION_ACTION, StepName } from './constants/step-names';

@Injectable()
export class IdempotencyLogRepository {
  async succeeded(
    manager: EntityManager,
    orderId: string,
    step: StepName,
  ): Promise<boolean> {
    const rows: { id: string }[] = await manager.query(
      'SELECT id FROM idempotency_log WHERE order_id=$1 AND action=$2 AND step=$3 AND success',
      [orderId, ACTIVATION_ACTION, step],
    );
    return rows.length > 0;
  }
  async record(
    manager: EntityManager,
    orderId: string,
    step: StepName,
    success: boolean,
    reference: Record<string, unknown>,
    description: string,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO idempotency_log (id,order_id,action,step,success,reference,description)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (order_id,action,step) WHERE success DO NOTHING`,
      [
        randomUUID(),
        orderId,
        ACTIVATION_ACTION,
        step,
        success,
        JSON.stringify(reference),
        description,
      ],
    );
  }
}
