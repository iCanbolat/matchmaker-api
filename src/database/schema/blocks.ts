import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('blocks_blocker_blocked_unique').on(
      table.blockerId,
      table.blockedId,
    ),
    index('idx_blocks_blocker_created').on(table.blockerId, table.createdAt),
    index('idx_blocks_blocked_blocker').on(table.blockedId, table.blockerId),
  ],
);
