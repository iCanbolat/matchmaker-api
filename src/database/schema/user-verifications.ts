import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

export const userVerifications = pgTable('user_verifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  selfieUrl: varchar('selfie_url', { length: 500 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('pending'),
  rejectionReason: text('rejection_reason'),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
