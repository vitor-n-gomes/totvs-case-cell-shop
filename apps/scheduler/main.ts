import 'reflect-metadata';
import { Logger as BootstrapLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppLogger } from '@app/platform/logging/app-logger';
// Must load before any repository: entity barrels are cyclic and DatabaseModule fixes the safe load order.
import { SchedulerModule } from './scheduler.module';
import { ExpireReservationsUseCase } from '../../libs/orders/src/adapters/usecases/expire-reservations.use-case';

// No HTTP server: the scheduler only polls the database and produces to Kafka.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SchedulerModule, {
    bufferLogs: true,
    abortOnError: false,
  });

  try {

    const appLogger = app.get(AppLogger);

    appLogger.setApp('scheduler');
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    app.get(ExpireReservationsUseCase).start();

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
