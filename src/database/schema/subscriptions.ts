import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: varchar('tier', { length: 32 }).notNull(),
    platform: varchar('platform', { length: 16 }).notNull(),
    storeTransactionId: varchar('store_transaction_id', { length: 255 }),
    startsAt: timestamp('starts_at').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    isCancelled: boolean('is_cancelled').notNull().default(false),
    cancelledAt: timestamp('cancelled_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('subscriptions_store_tx_unique').on(table.storeTransactionId),
    index('idx_subscriptions_user_expires').on(table.userId, table.expiresAt),
  ],
);
