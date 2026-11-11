import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { AppLogger } from '@app/platform/logging/app-logger';
import { ApiModule } from './http.module';
import { configureApi, createOpenApiDocument } from './configure-api';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  try {
    const logger = app.get(AppLogger);
    logger.setApp('api');
    app.useLogger(logger);
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
  new AppLogger().startupFailure('api', error);
  process.exitCode = 1;
});
