import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { executionContext } from '../observability/context';
import { AppLogger } from './app-logger';
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        base: undefined,
        level: 'info',
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
        autoLogging: false,
        // CorrelationMiddleware owns completion logs; omit automatic request payload bindings.
        quietReqLogger: true,
        quietResLogger: true,
        serializers: {
          req: () => undefined,
          res: () => undefined,
          err: (error: Error) => ({ type: error.name }),
        },
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'password',
          'secret',
          'token',
          'mainContact',
          'altContact',
        ],
        mixin: () => ({ ...executionContext.getStore() }),
      },
    }),
  ],
  providers: [AppLogger],
  exports: [AppLogger, LoggerModule],
})
export class LoggingModule {}
