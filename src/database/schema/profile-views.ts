import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const profileViews = pgTable(
  'profile_views',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    viewerId: uuid('viewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viewedId: uuid('viewed_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_profile_views_viewed').on(table.viewedId, table.createdAt),
    index('idx_profile_views_viewer').on(table.viewerId, table.createdAt),
  ],
);
