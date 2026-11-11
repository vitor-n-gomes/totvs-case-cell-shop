import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

export interface ClaimedEvent {
  id: string;
  order_id: string;
  topic: string;
  payload: Record<string, unknown>;
  lease_token: string;
}
@Injectable()
export class OutboxRepository {
  constructor(private readonly database: DataSource) {}
  async append(
    manager: EntityManager,
    orderId: string,
    topic: string,
    payload: object,
    deduplicationKey: string,
    delay = 0,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO outbox_events (id,order_id,topic,payload,deduplication_key,available_at)
      VALUES ($1,$2,$3,$4,$5,clock_timestamp() + $6 * interval '1 second') ON CONFLICT (deduplication_key) DO NOTHING`,
      [
        randomUUID(),
        orderId,
        topic,
        JSON.stringify(payload),
        deduplicationKey,
        delay,
      ],
    );
  }
  async claim(): Promise<ClaimedEvent[]> {
    const [events]: [ClaimedEvent[], number] = await this.database.query(
      `WITH candidates AS (
      SELECT id FROM outbox_events WHERE status='PENDING' AND available_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED
    ) UPDATE outbox_events e SET lease_token=$1,lease_until=clock_timestamp()+interval '30 seconds'
      FROM candidates c WHERE e.id=c.id RETURNING e.id,e.order_id,e.topic,e.payload,e.lease_token`,
      [randomUUID()],
    );
    return events;
  }
  async acknowledge(event: ClaimedEvent): Promise<void> {
    await this.database.query(
      "UPDATE outbox_events SET status='PROCESSED',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
      [event.id, event.lease_token],
    );
  }
  async release(event: ClaimedEvent): Promise<void> {
    await this.database.query(
      "UPDATE outbox_events SET lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '1 second' WHERE id=$1 AND lease_token=$2",
      [event.id, event.lease_token],
    );
  }
  async backlog(): Promise<{ count: string; age: string }> {
    const [row]: { count: string; age: string }[] = await this.database.query(
      "SELECT count(*)::text AS count,coalesce(extract(epoch FROM clock_timestamp()-min(created_at)),0)::text AS age FROM outbox_events WHERE status='PENDING'",
    );
    return row!;
  }
}
