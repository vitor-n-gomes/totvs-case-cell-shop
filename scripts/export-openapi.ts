import { ProductsController } from '@app/products/adapters/http/products.controller';
import { OrderController } from '../libs/orders/src/adapters/http/order.controller';
import { GetProductsUseCase } from '@app/products/adapters/usecases/get-products.use-case';
import { CheckoutUseCase } from '../libs/orders/src/adapters/usecases/checkout.use-case';
import { GetOrderStatusUseCase } from '../libs/orders/src/adapters/usecases/get-order-status.use-case';
import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import { createOpenApiDocument } from '../apps/http/src/configure-api';
import { LoggingModule } from '@app/platform/logging/logging.module';

async function exportDocument(): Promise<void> {
  const testingModule = await Test.createTestingModule({
    imports: [LoggingModule],
    controllers: [ProductsController, OrderController],
    providers: [
      { provide: GetProductsUseCase, useValue: {} },
      { provide: CheckoutUseCase, useValue: {} },
      { provide: GetOrderStatusUseCase, useValue: {} },
    ],
  }).compile();

  const app = testingModule.createNestApplication();

  try {

    await writeFile(
      'openapi.json',
      `${JSON.stringify(createOpenApiDocument(app), null, 2)}\n`,
    );

  } finally {

    await app.close();

  }
}

void exportDocument().catch(() => {
  process.stderr.write('OpenAPI export failed\n');
  process.exitCode = 1;
});
