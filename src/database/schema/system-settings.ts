import { jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const systemSettings = pgTable('system_settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
