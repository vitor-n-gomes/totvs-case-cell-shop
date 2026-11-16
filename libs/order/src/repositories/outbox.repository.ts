import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { OutboxEventEntity } from '../domain/entities';

export type ClaimedEvent = Pick<
  OutboxEventEntity,
  'id' | 'orderId' | 'topic' | 'payload'
> & { leaseToken: string };
@Injectable()
export class OutboxRepository {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(OutboxEventEntity)
    private readonly outboxEventTypeOrmRepository: Repository<OutboxEventEntity>,
  ) {}

  async append(
    entityManager: EntityManager,
    orderId: string,
    topic: string,
    payload: object,
    deduplicationKey: string,
    delaySeconds = 0,
  ): Promise<void> {
    await entityManager
      .getRepository(OutboxEventEntity)
      .createQueryBuilder()
      .insert()
      .values({
        id: randomUUID(),
        orderId,
        topic,
        payload: () => ':payload',
        deduplicationKey,
        availableAt: () => "clock_timestamp() + :delay * interval '1 second'",
      })
      .setParameter('delay', delaySeconds)
      .setParameter('payload', JSON.stringify(payload))
      .orIgnore()
      .execute();
  }

  claim(): Promise<ClaimedEvent[]> {
    return this.dataSource.transaction(async (entityManager) => {
      const outboxEventTypeOrmRepository =
        entityManager.getRepository(OutboxEventEntity);

      const outboxEvents = await outboxEventTypeOrmRepository
        .createQueryBuilder('event')
        .where('event.status = :status', { status: 'PENDING' })
        .andWhere('event.availableAt <= clock_timestamp()')
        .andWhere(
          '(event.leaseUntil IS NULL OR event.leaseUntil < clock_timestamp())',
        )
        .orderBy('event.createdAt', 'ASC')
        .addOrderBy('event.id', 'ASC')
        .take(20)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (!outboxEvents.length) {

        return [];

      }

      const leaseToken = randomUUID();

      await outboxEventTypeOrmRepository
        .createQueryBuilder()
        .update()
        .set({
          leaseToken,
          leaseUntil: () => "clock_timestamp() + interval '30 seconds'",
        })
        .whereInIds(outboxEvents.map((outboxEvent) => outboxEvent.id))
        .execute();

      return outboxEvents.map((outboxEvent) => ({
        ...outboxEvent,
        leaseToken,
      }));
    });
  }

  async acknowledge(outboxEvent: ClaimedEvent): Promise<void> {
    await this.outboxEventTypeOrmRepository.update(
      { id: outboxEvent.id, leaseToken: outboxEvent.leaseToken },
      { status: 'PROCESSED', leaseToken: null, leaseUntil: null },
    );
  }

  async release(outboxEvent: ClaimedEvent): Promise<void> {
    await this.outboxEventTypeOrmRepository
      .createQueryBuilder()
      .update()
      .set({
        leaseToken: null,
        leaseUntil: null,
        availableAt: () => "clock_timestamp() + interval '1 second'",
      })
      .where('id = :id AND lease_token = :leaseToken', {
        id: outboxEvent.id,
        leaseToken: outboxEvent.leaseToken,
      })
      .execute();
  }

  async backlog(): Promise<{ count: number; ageSeconds: number }> {
    const backlogRow = await this.outboxEventTypeOrmRepository
      .createQueryBuilder('event')
      .select('count(*)::text', 'count')
      .addSelect(
        'coalesce(extract(epoch FROM clock_timestamp()-min(event.createdAt)),0)::text',
        'age',
      )
      .where('event.status = :status', { status: 'PENDING' })
      .getRawOne<{ count: string; age: string }>();

    return {
      count: Number(backlogRow?.count ?? 0),
      ageSeconds: Number(backlogRow?.age ?? 0),
    };
  }
}
