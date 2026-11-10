import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class AppLogger implements LoggerService {
  private app = 'bootstrap';

  setApp(app: 'api' | 'worker'): void {
    this.app = app;
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write('info', message, fields);
  }
  log(message: unknown, ...context: unknown[]): void {
    this.write('info', message, { context });
  }
  warn(message: unknown, ...context: unknown[]): void {
    this.write('warn', message, { context });
  }
  error(message: unknown, ...context: unknown[]): void {
    this.write('error', message, { context });
  }
  debug(message: unknown, ...context: unknown[]): void {
    this.write('debug', message, { context });
  }
  verbose(message: unknown, ...context: unknown[]): void {
    this.write('debug', message, { context });
  }
  fatal(message: unknown, ...context: unknown[]): void {
    this.write('fatal', message, { context });
  }

  startupFailure(app: 'api' | 'worker', error: unknown): void {
    this.setApp(app);
    this.info(`${app}.startup.failed`, {
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
    level: string,
    message: unknown,
    fields: Record<string, unknown>,
  ): void {
    // Do not serialize arbitrary transport errors: they can contain connection URLs.
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        app: this.app,
        level,
        message: message instanceof Error ? message.name : message,
        ...fields,
      })}\n`,
    );
  }
}
