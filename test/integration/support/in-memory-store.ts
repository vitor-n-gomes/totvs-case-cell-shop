import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { CheckoutInput } from '@app/order/domain/dto/create-order.dto';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/order/domain/shared/types/order.type';

export interface ProductRecord {
  id: string;
  name: string;
  productKey: string;
  netPrice: number;
  listPrice: number;
  physicalQuantity: number;
  reservedQuantity: number;
}

export interface OrderRecord {
  id: string;
  paymentType: string;
  dueDate: string;
  mainContact: string;
  paymentMethod: string;
  environment: string;
  status: OrderStatus;
  processingStatus: ProcessingStatus;
  idempotencyKey: string;
  requestHash: string;
  correlationId: string;
  createdAt: Date;
}

export interface OrderItemRecord {
  orderId: string;
  productId: string;
  quantity: number;
  netPrice: number;
  listPrice: number;
}

export interface ReservationRecord {
  orderId: string;
  productId: string;
  quantity: number;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
}

export interface OutboxRecord {
  orderId: string;
  topic: string;
  payload: unknown;
  deduplicationKey: string;
  status: 'PENDING' | 'PROCESSED';
}

/**
 * Shared in-memory "database" behind the fake repositories below.
 * TODO: drop these fakes and run the same specs against a real PostgreSQL
 * (testcontainers or the `_test` database) with migrations applied.
 */
export class InMemoryStore {
  readonly products = new Map<string, ProductRecord>();
  readonly orders = new Map<string, OrderRecord>();
  readonly items: OrderItemRecord[] = [];
  readonly reservations: ReservationRecord[] = [];
  readonly outbox: OutboxRecord[] = [];
  catalogQueries = 0;

  seedProducts(products: ProductRecord[]): void {
    for (const product of products) {
      this.products.set(product.id, product);
    }
  }
}

export class FakeDataSource {
  // The real transaction is atomic; happy paths never need a rollback.
  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return work({} as EntityManager);
  }
}

export class FakeProductRepository {
  constructor(private readonly store: InMemoryStore) {}

  findAll() {
    this.store.catalogQueries += 1;

    return Promise.resolve(
      [...this.store.products.values()]
        .filter(
          ({ physicalQuantity, reservedQuantity }) =>
            physicalQuantity - reservedQuantity >= 1,
        )
        .sort((a, b) => a.productKey.localeCompare(b.productKey))
        .map(({ id, name, productKey, netPrice, listPrice }) => ({
          id,
          name,
          productKey,
          netPrice,
          listPrice,
        })),
    );
  }
}

export class FakeOrderRepository {
  constructor(private readonly store: InMemoryStore) {}

  insertPending(
    _manager: EntityManager,
    id: string,
    input: CheckoutInput,
    idempotencyKey: string,
    requestHash: string,
    correlationId: string,
  ): Promise<boolean> {
    if (this.find(idempotencyKey)) {
      return Promise.resolve(false);
    }

    this.store.orders.set(id, {
      id,
      paymentType: input.paymentType,
      dueDate: input.dueDate,
      mainContact: input.mainContact,
      paymentMethod: input.paymentMethod,
      environment: input.environment,
      status: OrderStatus.Pending,
      processingStatus: ProcessingStatus.Pending,
      idempotencyKey,
      requestHash,
      correlationId,
      createdAt: new Date(),
    });

    return Promise.resolve(true);
  }

  findByKey(_manager: EntityManager, idempotencyKey: string) {
    return Promise.resolve(this.find(idempotencyKey) ?? null);
  }

  findById(id: string) {
    return Promise.resolve(this.store.orders.get(id) ?? null);
  }

  findItems(orderId: string) {
    return Promise.resolve(
      this.store.items
        .filter((item) => item.orderId === orderId)
        .sort((a, b) => a.productId.localeCompare(b.productId)),
    );
  }

  addItems(
    _manager: EntityManager,
    orderId: string,
    items: Omit<OrderItemRecord, 'orderId'>[],
  ): Promise<void> {
    this.store.items.push(...items.map((item) => ({ ...item, orderId })));

    return Promise.resolve();
  }

  private find(idempotencyKey: string): OrderRecord | undefined {
    return [...this.store.orders.values()].find(
      (order) => order.idempotencyKey === idempotencyKey,
    );
  }
}

export class FakeStockRepository {
  constructor(private readonly store: InMemoryStore) {}

  reserve(
    _manager: EntityManager,
    orderId: string,
    items: { productId: string; quantity: number }[],
  ) {
    return Promise.resolve(
      items.map(({ productId, quantity }) => {
        const product = this.store.products.get(productId);

        if (!product) {
          throw new Error(`Seed product ${productId} first`);
        }

        product.reservedQuantity += quantity;

        this.store.reservations.push({
          orderId,
          productId,
          quantity,
          status: 'ACTIVE',
        });

        return {
          productId,
          quantity,
          netPrice: product.netPrice,
          listPrice: product.listPrice,
        };
      }),
    );
  }
}

export class FakeOutboxRepository {
  constructor(private readonly store: InMemoryStore) {}

  append(
    _manager: EntityManager,
    orderId: string,
    topic: string,
    payload: object,
    deduplicationKey: string,
  ): Promise<void> {
    const duplicate = this.store.outbox.some(
      (event) => event.deduplicationKey === deduplicationKey,
    );

    if (!duplicate) {
      this.store.outbox.push({
        orderId,
        topic,
        payload,
        deduplicationKey,
        status: 'PENDING',
      });
    }

    return Promise.resolve();
  }
}

export function newProduct(
  overrides: Partial<ProductRecord> = {},
): ProductRecord {
  const id = overrides.id ?? randomUUID();

  return {
    id,
    name: `Case ${id.slice(0, 8)}`,
    productKey: `case-${id.slice(0, 8)}`,
    netPrice: 2990,
    listPrice: 3990,
    physicalQuantity: 10,
    reservedQuantity: 0,
    ...overrides,
  };
}
