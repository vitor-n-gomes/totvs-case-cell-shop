import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { AppLogger } from '@app/platform/logging/app-logger';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly appLogger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId: unknown = response.locals.correlationId;

    const statusCode =
      exception instanceof HttpException ? exception.getStatus() : 500;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    const message =
      typeof exceptionResponse === 'object' &&
      exceptionResponse &&
      'message' in exceptionResponse
        ? exceptionResponse.message
        : typeof exceptionResponse === 'string'
          ? exceptionResponse
          : 'Internal server error';

    if (statusCode >= 500) {

      this.appLogger.info('http.request.failed', {
        correlation_id: correlationId,
        status_code: statusCode,
      });

    }

    response.status(statusCode).json({
      statusCode,
      error: STATUS_CODES[statusCode],
      message,
      correlationId,
    });
  }
}
