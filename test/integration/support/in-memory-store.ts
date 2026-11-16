import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { CheckoutCommand } from '@app/orders/domain/dto/create-order.dto';
import {
  OrderStatus,
  ProcessingStatus,
} from '@app/orders/domain/shared/types/order.type';

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
 * Real-service integration tests also exercise the migrated `_test` database.
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
  transaction<T>(
    transactionOperation: (entityManager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return transactionOperation({} as EntityManager);
  }
}

export class FakeProductRepository {
  constructor(private readonly inMemoryStore: InMemoryStore) {}

  findAll() {
    this.inMemoryStore.catalogQueries += 1;

    return Promise.resolve(
      [...this.inMemoryStore.products.values()]
        .filter(
          ({ physicalQuantity, reservedQuantity }) =>
            physicalQuantity - reservedQuantity >= 1,
        )
        .sort((leftProduct, rightProduct) =>
          leftProduct.productKey.localeCompare(rightProduct.productKey),
        )
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
  constructor(private readonly inMemoryStore: InMemoryStore) {}

  insertPending(
    _entityManager: EntityManager,
    orderId: string,
    checkoutDto: CheckoutCommand,
    idempotencyKey: string,
    requestHash: string,
    correlationId: string,
  ): Promise<boolean> {
    if (this.find(idempotencyKey)) {

      return Promise.resolve(false);

    }

    this.inMemoryStore.orders.set(orderId, {
      id: orderId,
      paymentType: checkoutDto.paymentType,
      dueDate: checkoutDto.dueDate,
      mainContact: checkoutDto.mainContact,
      paymentMethod: checkoutDto.paymentMethod,
      environment: checkoutDto.environment,
      status: OrderStatus.Pending,
      processingStatus: ProcessingStatus.Pending,
      idempotencyKey,
      requestHash,
      correlationId,
      createdAt: new Date(),
    });

    return Promise.resolve(true);
  }

  findByKey(_entityManager: EntityManager, idempotencyKey: string) {
    return Promise.resolve(this.find(idempotencyKey) ?? null);
  }

  findById(orderId: string) {
    return Promise.resolve(this.inMemoryStore.orders.get(orderId) ?? null);
  }

  findItems(orderId: string) {
    return Promise.resolve(
      this.inMemoryStore.items
        .filter((item) => item.orderId === orderId)
        .sort((leftOrderItem, rightOrderItem) =>
          leftOrderItem.productId.localeCompare(rightOrderItem.productId),
        ),
    );
  }

  addItems(
    _entityManager: EntityManager,
    orderId: string,
    items: Omit<OrderItemRecord, 'orderId'>[],
  ): Promise<void> {
    this.inMemoryStore.items.push(
      ...items.map((item) => ({ ...item, orderId })),
    );

    return Promise.resolve();
  }

  private find(idempotencyKey: string): OrderRecord | undefined {
    return [...this.inMemoryStore.orders.values()].find(
      (order) => order.idempotencyKey === idempotencyKey,
    );
  }
}

export class FakeStockRepository {
  constructor(private readonly inMemoryStore: InMemoryStore) {}

  reserve(
    _entityManager: EntityManager,
    orderId: string,
    items: { productId: string; quantity: number }[],
  ) {
    return Promise.resolve(
      items.map(({ productId, quantity }) => {
        const product = this.inMemoryStore.products.get(productId);

        if (!product) {

          throw new Error(`Seed product ${productId} first`);

        }

        product.reservedQuantity += quantity;

        this.inMemoryStore.reservations.push({
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
  constructor(private readonly inMemoryStore: InMemoryStore) {}

  append(
    _entityManager: EntityManager,
    orderId: string,
    topic: string,
    payload: object,
    deduplicationKey: string,
  ): Promise<void> {
    const isDuplicateEvent = this.inMemoryStore.outbox.some(
      (event) => event.deduplicationKey === deduplicationKey,
    );

    if (!isDuplicateEvent) {

      this.inMemoryStore.outbox.push({
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
  const productId = overrides.id ?? randomUUID();

  return {
    id: productId,
    name: `Case ${productId.slice(0, 8)}`,
    productKey: `case-${productId.slice(0, 8)}`,
    netPrice: 2990,
    listPrice: 3990,
    physicalQuantity: 10,
    reservedQuantity: 0,
    ...overrides,
  };
}
