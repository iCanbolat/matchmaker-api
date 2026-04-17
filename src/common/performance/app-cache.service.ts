import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { type Env } from '../../config/env.schema';

type CacheEntry = {
  value: string;
  expiresAt: number;
};

@Injectable()
export class AppCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(AppCacheService.name);
  private readonly enabled: boolean;
  private readonly defaultTtlSeconds: number;
  private readonly memoryMaxKeys: number;
  private readonly redisEnabled: boolean;
  private readonly keyPrefix: string;

  private readonly memoryCache = new Map<string, CacheEntry>();
  private redisClient: Redis | null = null;
  private redisConnectAttempted = false;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private readonly configService: ConfigService<Env, true>) {
    this.enabled = this.configService.get('CACHE_ENABLED', { infer: true });
    this.defaultTtlSeconds = this.configService.get(
      'CACHE_DEFAULT_TTL_SECONDS',
      {
        infer: true,
      },
    );
    this.memoryMaxKeys = this.configService.get('CACHE_MEMORY_MAX_KEYS', {
      infer: true,
    });
    this.redisEnabled = this.configService.get('CACHE_REDIS_ENABLED', {
      infer: true,
    });
    this.keyPrefix = this.configService.get('CACHE_REDIS_PREFIX', {
      infer: true,
    });

    if (!this.enabled) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredEntries();
    }, 30_000);

    if (this.redisEnabled) {
      this.redisClient = this.createRedisClient();

      this.redisClient.on('error', (error) => {
        this.logger.warn(`Redis cache error: ${error.message}`);
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (!this.redisClient) {
      return;
    }

    try {
      await this.redisClient.quit();
    } catch {
      this.redisClient.disconnect(false);
    }

    this.redisClient = null;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.enabled) {
      return undefined;
    }

    const internalKey = this.toInternalKey(key);
    const memoryHit = this.getFromMemory(internalKey);

    if (memoryHit !== undefined) {
      return this.deserialize<T>(memoryHit, internalKey);
    }

    const redisHit = await this.getFromRedis(internalKey);

    if (redisHit === undefined) {
      return undefined;
    }

    return this.deserialize<T>(redisHit, internalKey);
  }

  async set<T>(
    key: string,
    value: T,
    ttlSeconds = this.defaultTtlSeconds,
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const serialized = JSON.stringify(value);

    if (serialized === undefined) {
      return;
    }

    const normalizedTtlSeconds = Math.max(1, Math.floor(ttlSeconds));
    const internalKey = this.toInternalKey(key);

    this.setInMemory(internalKey, serialized, normalizedTtlSeconds);
    await this.setInRedis(internalKey, serialized, normalizedTtlSeconds);
  }

  async del(key: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const internalKey = this.toInternalKey(key);
    this.memoryCache.delete(internalKey);

    if (!this.redisClient) {
      return;
    }

    try {
      await this.redisClient.del(internalKey);
    } catch (error) {
      this.logger.warn(
        `Redis cache delete failed for ${internalKey}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  async delByPrefix(prefix: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const internalPrefix = this.toInternalKey(prefix);

    for (const key of Array.from(this.memoryCache.keys())) {
      if (key.startsWith(internalPrefix)) {
        this.memoryCache.delete(key);
      }
    }

    if (!this.redisClient) {
      return;
    }

    try {
      let cursor = '0';

      do {
        const [nextCursor, keys] = await this.redisClient.scan(
          cursor,
          'MATCH',
          `${internalPrefix}*`,
          'COUNT',
          '200',
        );

        cursor = nextCursor;

        if (keys.length > 0) {
          await this.redisClient.del(...keys);
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(
        `Redis cache prefix delete failed for ${internalPrefix}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    resolver: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get<T>(key);

    if (cached !== undefined) {
      return cached;
    }

    const value = await resolver();
    await this.set<T>(key, value, ttlSeconds);

    return value;
  }

  private toInternalKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  private createRedisClient(): Redis {
    const host = this.configService.get('REDIS_HOST', { infer: true });
    const port = this.configService.get('REDIS_PORT', { infer: true });
    const db = this.configService.get('REDIS_DB', { infer: true });
    const password = this.configService.get('REDIS_PASSWORD', {
      infer: true,
    });

    return new Redis({
      host,
      port,
      db,
      password: password.length > 0 ? password : undefined,
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableReadyCheck: false,
    });
  }

  private getFromMemory(key: string): string | undefined {
    const entry = this.memoryCache.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  private setInMemory(
    key: string,
    serializedValue: string,
    ttlSeconds: number,
  ) {
    if (this.memoryCache.size >= this.memoryMaxKeys) {
      const oldestKeyResult = this.memoryCache.keys().next();

      if (!oldestKeyResult.done) {
        this.memoryCache.delete(oldestKeyResult.value);
      }
    }

    this.memoryCache.set(key, {
      value: serializedValue,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();

    for (const [key, value] of this.memoryCache.entries()) {
      if (value.expiresAt <= now) {
        this.memoryCache.delete(key);
      }
    }
  }

  private async getFromRedis(key: string): Promise<string | undefined> {
    if (!this.redisClient) {
      return undefined;
    }

    await this.ensureRedisConnection();

    try {
      const value = await this.redisClient.get(key);
      return value ?? undefined;
    } catch (error) {
      this.logger.warn(
        `Redis cache read failed for ${key}: ${this.toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async setInRedis(
    key: string,
    serializedValue: string,
    ttlSeconds: number,
  ): Promise<void> {
    if (!this.redisClient) {
      return;
    }

    await this.ensureRedisConnection();

    try {
      await this.redisClient.set(key, serializedValue, 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(
        `Redis cache write failed for ${key}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  private async ensureRedisConnection(): Promise<void> {
    if (!this.redisClient || this.redisConnectAttempted) {
      return;
    }

    this.redisConnectAttempted = true;

    try {
      await this.redisClient.connect();
    } catch {
      // ioredis may throw when already connected; runtime operations remain safe.
    }
  }

  private deserialize<T>(value: string, key: string): T | undefined {
    try {
      return JSON.parse(value) as T;
    } catch {
      this.memoryCache.delete(key);
      return undefined;
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'unknown_error';
  }
}
