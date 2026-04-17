import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const userBoosts = pgTable(
  'user_boosts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_user_boosts_user_active_window').on(
      table.userId,
      table.startsAt,
      table.expiresAt,
    ),
    index('idx_user_boosts_user_created').on(table.userId, table.createdAt),
    index('idx_user_boosts_active_window').on(table.startsAt, table.expiresAt),
  ],
);
