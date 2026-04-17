import { integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const userReferralCredits = pgTable('user_referral_credits', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  swipeCredits: integer('swipe_credits').notNull().default(0),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
