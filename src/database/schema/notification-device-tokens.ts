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

export const notificationDeviceTokens = pgTable(
  'notification_device_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 16 }).notNull(),
    deviceToken: varchar('device_token', { length: 512 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_device_tokens_token_unique').on(
      table.deviceToken,
    ),
    index('idx_notification_device_tokens_user').on(
      table.userId,
      table.isActive,
    ),
  ],
);
