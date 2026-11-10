import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './environment';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      // Process variables win; local overrides take precedence over .env.
      envFilePath: process.env.ENV_FILE ?? ['.env.local', '.env'],
      validate: validateEnvironment,
    }),
  ],
})
export class ConfigurationModule {}
