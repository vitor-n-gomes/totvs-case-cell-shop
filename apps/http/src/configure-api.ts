import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppLogger } from '@app/platform/logging/app-logger';
import { HttpExceptionFilter } from './http-exception.filter';

export function configureApi(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter(app.get(AppLogger)));
}

export function createOpenApiDocument(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('CaseCellShop')
      .setDescription(
        'Cached catalog, idempotent checkout and asynchronous order activation.',
      )
      .setVersion('1.0.0')
      .build(),
  );
}
