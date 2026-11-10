import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import { DemoController } from '../apps/api/src/demo/demo.controller';
import { createOpenApiDocument } from '../apps/api/src/configure-api';
import { PublishMessage } from '@app/demo/use-cases/publish-message';
import { GetReceipt } from '@app/demo/use-cases/get-receipt';
import { AppLogger } from '@app/platform/logging/app-logger';

async function exportDocument(): Promise<void> {
  const module = await Test.createTestingModule({
    controllers: [DemoController],
    providers: [
      AppLogger,
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
