import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as BootstrapLogger } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { AppLogger } from '@app/platform/logging/app-logger';
import { HttpModule } from './http.module';
import { configureApi, createOpenApiDocument } from './configure-api';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(HttpModule, {
    bufferLogs: true,
    abortOnError: false,
  });

  try {

    const appLogger = app.get(AppLogger);

    appLogger.setApp('http');
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    configureApi(app);
    SwaggerModule.setup('api-docs', app, createOpenApiDocument(app));

    await app.listen(
      app.get(ConfigService).getOrThrow<number>('API_PORT'),
      '0.0.0.0',
    );

  } catch (error) {

    await app.close();

    throw error;

  }
}

void bootstrap().catch((error: unknown) => {
  new BootstrapLogger('Bootstrap').error(
    error instanceof Error && error.message.startsWith('Invalid configuration:')
      ? error.message
      : 'http.startup.failed',
  );

  process.exitCode = 1;
});
