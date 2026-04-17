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

export const swipes = pgTable(
  'swipes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    swiperId: uuid('swiper_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    swipedId: uuid('swiped_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    direction: varchar('direction', { length: 16 }).notNull(),
    isUndone: boolean('is_undone').notNull().default(false),
    undoneAt: timestamp('undone_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('swipes_swiper_swiped_unique').on(
      table.swiperId,
      table.swipedId,
    ),
    index('idx_swipes_swiper_direction_active_created').on(
      table.swiperId,
      table.direction,
      table.isUndone,
      table.createdAt,
    ),
    index('idx_swipes_swiper_created').on(table.swiperId, table.createdAt),
    index('idx_swipes_swiper_undone').on(table.swiperId, table.undoneAt),
    index('idx_swipes_swiped').on(table.swipedId, table.direction),
  ],
);
