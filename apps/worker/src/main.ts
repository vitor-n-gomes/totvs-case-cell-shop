import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '@app/platform/logging/app-logger';
import { WorkerModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(WorkerModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  try {
    const logger = app.get(AppLogger);
    logger.setApp('worker');
    app.useLogger(logger);
    app.enableShutdownHooks();
    await app.listen(
      app.get(ConfigService).getOrThrow<number>('WORKER_PORT'),
      '0.0.0.0',
    );
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  new AppLogger().startupFailure('worker', error);
  process.exitCode = 1;
});
