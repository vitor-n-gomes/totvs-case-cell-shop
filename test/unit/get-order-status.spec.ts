import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetOrderStatusUseCase } from '@app/orders/adapters/usecases/get-order-status.use-case';
import { OrderRepository } from '@app/orders/repositories/order.repository';
import { orderFixture } from './support/fixtures';

describe('GetOrderStatusUseCase', () => {
  async function setup() {
    const order = orderFixture();

    const repository = {
      findById: jest.fn().mockResolvedValue(order),
      findItems: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GetOrderStatusUseCase,
        { provide: OrderRepository, useValue: repository },
      ],
    }).compile();

    return { service: moduleRef.get(GetOrderStatusUseCase), repository, order };
  }

  it('returns only public order fields and serializes date and integer prices', async () => {
    const { service, repository, order } = await setup();

    repository.findItems.mockResolvedValue([
      {
        productId: 'product',
        quantity: 2,
        netPrice: '1000',
        listPrice: '1500',
        orderId: order.id,
      },
    ]);

    await expect(service.execute(order.id)).resolves.toEqual({
      orderId: order.id,
      status: order.status,
      processingStatus: order.processingStatus,
      paymentType: order.paymentType,
      paymentMethod: order.paymentMethod,
      dueDate: order.dueDate,
      environment: order.environment,
      createdAt: '2026-11-16T12:00:00.000Z',
      items: [
        { productId: 'product', quantity: 2, netPrice: 1000, listPrice: 1500 },
      ],
    });
  });

  it('supports orders with no persisted items', async () => {
    const { service, order } = await setup();

    await expect(service.execute(order.id)).resolves.toMatchObject({
      items: [],
    });
  });

  it('returns 404 for an unknown order without reading items', async () => {
    const { service, repository } = await setup();

    repository.findById.mockResolvedValue(null);

    await expect(service.execute('unknown')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(repository.findItems).not.toHaveBeenCalled();
  });

  it.each(['findById', 'findItems'] as const)(
    'propagates repository failure from %s',
    async (method) => {
      const { service, repository, order } = await setup();
      const failure = new Error('database unavailable');

      repository[method].mockRejectedValue(failure);
      await expect(service.execute(order.id)).rejects.toBe(failure);
    },
  );
});
