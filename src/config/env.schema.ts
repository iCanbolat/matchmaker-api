import { z } from 'zod';

const envBoolean = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://postgres:postgres@localhost:5432/matchmaker'),
  DATABASE_POOL_MIN: z.coerce.number().int().positive().default(5),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().default(''),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  NOTIFICATIONS_QUEUE_ENABLED: envBoolean.default(false),
  PUSH_DELIVERY_ENABLED: envBoolean.default(false),
  ONESIGNAL_APP_ID: z.string().min(1).optional(),
  ONESIGNAL_REST_API_KEY: z.string().min(1).optional(),
  ONESIGNAL_API_BASE_URL: z
    .string()
    .url()
    .default('https://onesignal.com/api/v1'),

  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me'),
  JWT_ACCESS_EXPIRATION: z.string().default('15m'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(16)
    .default('dev-refresh-secret-change-me'),
  JWT_REFRESH_EXPIRATION: z.string().default('7d'),

  PUBLIC_REGISTRATION_ENABLED: envBoolean.default(false),
  ADMIN_EMAILS: z.string().default(''),
  REFERRAL_BONUS_TYPE: z
    .enum(['none', 'plus_days', 'swipe_credit'])
    .default('plus_days'),
  REFERRAL_BONUS_PLUS_DAYS: z.coerce.number().int().positive().default(3),
  REFERRAL_BONUS_SWIPE_CREDITS: z.coerce.number().int().positive().default(20),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  APPLE_CLIENT_ID: z.string().min(1).optional(),

  UPLOAD_STRATEGY: z.enum(['local', 'bunny']).optional(),
  UPLOAD_DIR: z.string().default('uploads'),
  BUNNY_STORAGE_ZONE: z.string().optional(),
  BUNNY_ACCESS_KEY: z.string().optional(),
  BUNNY_PULL_ZONE_URL: z.string().url().optional(),
  BUNNY_STORAGE_HOST: z.string().default('storage.bunnycdn.com'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Environment validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
}
