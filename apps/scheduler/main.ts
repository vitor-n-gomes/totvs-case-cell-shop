import 'reflect-metadata';
import { Logger as BootstrapLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppLogger } from '@app/platform/logging/app-logger';
import { HealthService } from '@app/platform/health/health.service';
import { SchedulerModule } from './scheduler.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(SchedulerModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  try {
    const logger = app.get(AppLogger);
    logger.setApp('scheduler');
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    const config = app.get(ConfigService);
    const health = app.get(HealthService);
    health.schedulerReady = true;

    await app.listen(config.getOrThrow<number>('SCHEDULER_PORT'), '0.0.0.0');
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  new BootstrapLogger('Bootstrap').error(
    error instanceof Error && error.message.startsWith('Invalid configuration:')
      ? error.message
      : 'scheduler.startup.failed',
  );
  process.exitCode = 1;
});
