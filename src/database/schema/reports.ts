import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportedId: uuid('reported_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: varchar('reason', { length: 32 }).notNull(),
    description: text('description'),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_reports_reporter_created').on(table.reporterId, table.createdAt),
    index('idx_reports_reported_status_created').on(
      table.reportedId,
      table.status,
      table.createdAt,
    ),
  ],
);
