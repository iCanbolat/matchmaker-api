import {
  AnyPgColumn,
  boolean,
  date,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  phoneNumber: varchar('phone_number', { length: 20 }).unique(),
  googleId: varchar('google_id', { length: 255 }).unique(),
  appleId: varchar('apple_id', { length: 255 }).unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  refreshTokenHash: varchar('refresh_token_hash', { length: 255 }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }),
  birthDate: date('birth_date').notNull(),
  gender: varchar('gender', { length: 32 }).notNull(),
  bio: text('bio'),
  referralCode: varchar('referral_code', { length: 12 }).notNull().unique(),
  referredBy: uuid('referred_by').references((): AnyPgColumn => users.id, {
    onDelete: 'set null',
  }),
  isVerified: boolean('is_verified').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  isFrozen: boolean('is_frozen').notNull().default(false),
  frozenAt: timestamp('frozen_at'),
  deletedAt: timestamp('deleted_at'),
  subscriptionTier: varchar('subscription_tier', { length: 32 })
    .notNull()
    .default('free'),
  subscriptionExpiresAt: timestamp('subscription_expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
