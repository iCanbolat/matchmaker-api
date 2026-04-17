import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const matches = pgTable(
  'matches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    user1Id: uuid('user1_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    user2Id: uuid('user2_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    matchedAt: timestamp('matched_at').notNull().defaultNow(),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [
    uniqueIndex('matches_user1_user2_unique').on(table.user1Id, table.user2Id),
    index('idx_matches_user1').on(table.user1Id),
    index('idx_matches_user2').on(table.user2Id),
  ],
);
