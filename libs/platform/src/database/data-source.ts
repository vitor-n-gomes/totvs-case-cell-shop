import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../config/environment';
import { databaseOptions } from './options';

if (process.env.NODE_ENV !== 'test') {
  config({ path: process.env.ENV_FILE ?? ['.env.local', '.env'] });
}

const environment = validateEnvironment(process.env);

export default new DataSource(databaseOptions(environment.DATABASE_URL));
