import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { type Env } from '../config/env.schema';
import * as schema from './schema';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly client: Sql;
  readonly db: PostgresJsDatabase<typeof schema>;

  constructor(private readonly configService: ConfigService<Env, true>) {
    const connectionString = this.configService.get('DATABASE_URL', {
      infer: true,
    });
    const max = this.configService.get('DATABASE_POOL_MAX', { infer: true });

    this.client = postgres(connectionString, {
      max,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });

    this.db = drizzle(this.client, { schema });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.end();
  }
}
