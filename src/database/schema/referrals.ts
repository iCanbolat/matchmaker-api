import {
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const referrals = pgTable('referrals', {
  id: uuid('id').defaultRandom().primaryKey(),
  referrerId: uuid('referrer_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  referredId: uuid('referred_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  referralCodeUsed: varchar('referral_code_used', { length: 12 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('completed'),
  bonusType: varchar('bonus_type', { length: 32 }).notNull().default('none'),
  bonusValue: integer('bonus_value').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
