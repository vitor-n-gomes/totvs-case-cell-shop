import { PinoLogger } from 'nestjs-pino';
import { executionContext } from '../observability/context';
import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class AppLogger implements LoggerService {
  private appName = 'bootstrap';
  constructor(private readonly pinoLogger: PinoLogger) {}

  setApp(appName: 'http' | 'consumer' | 'scheduler'): void {
    this.appName = appName;
  }

  info(message: string, logFields: Record<string, unknown> = {}): void {
    this.write('info', message, logFields);
  }

  log(message: unknown, ...logContext: unknown[]): void {
    this.write('info', message, { context: logContext });
  }

  warn(message: unknown, ...logContext: unknown[]): void {
    this.write('warn', message, { context: logContext });
  }

  error(message: unknown, ...logContext: unknown[]): void {
    this.write('error', message, { context: logContext });
  }

  debug(message: unknown, ...logContext: unknown[]): void {
    this.write('debug', message, { context: logContext });
  }

  verbose(message: unknown, ...logContext: unknown[]): void {
    this.write('debug', message, { context: logContext });
  }

  fatal(message: unknown, ...logContext: unknown[]): void {
    this.write('fatal', message, { context: logContext });
  }

  startupFailure(
    appName: 'http' | 'consumer' | 'scheduler',
    error: unknown,
  ): void {
    this.setApp(appName);

    this.info(`${appName}.startup.failed`, {
      error:
        error instanceof Error &&
        error.message.startsWith('Invalid configuration:')
          ? error.message
          : error instanceof Error
            ? error.name
            : 'UnknownError',
    });
  }

  private write(
    logLevel: string,
    message: unknown,
    logFields: Record<string, unknown>,
  ): void {
    this.pinoLogger[logLevel as 'info' | 'warn' | 'error' | 'debug' | 'fatal'](
      {
        app: this.appName,
        ...executionContext.getStore(),
        ...logFields,
      },
      message instanceof Error
        ? message.name
        : typeof message === 'string'
          ? message
          : 'application.log',
    );
  }
}
