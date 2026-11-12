import { CatalogController } from '@app/shop/adapters/http/catalog.controller';
import { OrderController } from '@app/order/adapters/http/order.controller';
import { GetProducts } from '@app/shop/catalog/get-products';
import { Checkout } from '@app/order/adapters/usecases/checkout';
import { GetOrderStatus } from '@app/order/adapters/usecases/get-order-status';
import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import { DemoController } from '../apps/http/src/demo/demo.controller';
import { createOpenApiDocument } from '../apps/http/src/configure-api';
import { PublishMessage } from '@app/demo/use-cases/publish-message';
import { GetReceipt } from '@app/demo/use-cases/get-receipt';
import { LoggingModule } from '@app/platform/logging/logging.module';

async function exportDocument(): Promise<void> {
  const module = await Test.createTestingModule({
    imports: [LoggingModule],
    controllers: [DemoController, CatalogController, OrderController],
    providers: [
      { provide: GetProducts, useValue: {} },
      { provide: Checkout, useValue: {} },
      { provide: GetOrderStatus, useValue: {} },
      { provide: PublishMessage, useValue: {} },
      { provide: GetReceipt, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication();
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
