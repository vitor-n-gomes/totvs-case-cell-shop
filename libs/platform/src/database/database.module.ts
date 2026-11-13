import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseOptions } from './options';

/**
 *
 * based on my entities, please recreate my database schema using foreign keys,
 * ensuring all relationships are properly defined. inside my database and entities.
 * refatory my repositories to bring the relationships in line with the updated schema.
 *
 */

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...databaseOptions(config.getOrThrow<string>('DATABASE_URL')),
        retryAttempts: 1,
      }),
    }),
  ],
})
export class DatabaseModule {}
