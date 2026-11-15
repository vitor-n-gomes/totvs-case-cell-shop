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
    private readonly database: DataSource,
    @InjectRepository(OutboxEventEntity)
    private readonly events: Repository<OutboxEventEntity>,
  ) {}

  async append(
    manager: EntityManager,
    orderId: string,
    topic: string,
    payload: object,
    deduplicationKey: string,
    delay = 0,
  ): Promise<void> {
    await manager
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
      .setParameter('delay', delay)
      .setParameter('payload', JSON.stringify(payload))
      .orIgnore()
      .execute();
  }

  claim(): Promise<ClaimedEvent[]> {
    return this.database.transaction(async (manager) => {
      const repository = manager.getRepository(OutboxEventEntity);
      const events = await repository
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
      if (!events.length) return [];
      const leaseToken = randomUUID();
      await repository
        .createQueryBuilder()
        .update()
        .set({
          leaseToken,
          leaseUntil: () => "clock_timestamp() + interval '30 seconds'",
        })
        .whereInIds(events.map((event) => event.id))
        .execute();
      return events.map((event) => ({ ...event, leaseToken }));
    });
  }

  async acknowledge(event: ClaimedEvent): Promise<void> {
    await this.events.update(
      { id: event.id, leaseToken: event.leaseToken },
      { status: 'PROCESSED', leaseToken: null, leaseUntil: null },
    );
  }

  async release(event: ClaimedEvent): Promise<void> {
    await this.events
      .createQueryBuilder()
      .update()
      .set({
        leaseToken: null,
        leaseUntil: null,
        availableAt: () => "clock_timestamp() + interval '1 second'",
      })
      .where('id = :id AND lease_token = :leaseToken', {
        id: event.id,
        leaseToken: event.leaseToken,
      })
      .execute();
  }

  async backlog(): Promise<{ count: number; ageSeconds: number }> {
    const row = await this.events
      .createQueryBuilder('event')
      .select('count(*)::text', 'count')
      .addSelect(
        'coalesce(extract(epoch FROM clock_timestamp()-min(event.createdAt)),0)::text',
        'age',
      )
      .where('event.status = :status', { status: 'PENDING' })
      .getRawOne<{ count: string; age: string }>();
    return {
      count: Number(row?.count ?? 0),
      ageSeconds: Number(row?.age ?? 0),
    };
  }
}
