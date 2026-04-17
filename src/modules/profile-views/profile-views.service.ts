import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  notInArray,
  sql,
} from 'drizzle-orm';
import { AppCacheService } from '../../common/performance/app-cache.service';
import { DatabaseService } from '../../database/database.service';
import { profileViews, userPhotos, users } from '../../database/schema';
import { BlocksService } from '../blocks/blocks.service';
import { SubscriptionPolicyService } from '../subscriptions/subscription-policy.service';

type SelectClient = {
  select: DatabaseService['db']['select'];
};

type InsertClient = {
  insert: DatabaseService['db']['insert'];
};

type ReadWriteClient = SelectClient & InsertClient;

const DEFAULT_PROFILE_VIEWS_LIMIT = 20;
const MAX_PROFILE_VIEWS_LIMIT = 100;
const PROFILE_VIEWS_LIST_CACHE_TTL_SECONDS = 15;
const PROFILE_VIEWS_COUNT_CACHE_TTL_SECONDS = 10;

@Injectable()
export class ProfileViewsService {
  constructor(
    private readonly appCacheService: AppCacheService,
    private readonly blocksService: BlocksService,
    private readonly databaseService: DatabaseService,
    private readonly subscriptionPolicyService: SubscriptionPolicyService,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async listProfileViews(userId: string, requestedLimit?: number) {
    const user = await this.ensureUserExists(userId);
    const effectiveTier = this.subscriptionPolicyService.resolveEffectiveTier(
      user.subscriptionTier,
      user.subscriptionExpiresAt,
    );

    if (effectiveTier !== 'premium') {
      throw new ForbiddenException(
        'Profile views list is available for Premium members only.',
      );
    }

    const limit = this.resolveLimit(requestedLimit);

    return this.appCacheService.getOrSet(
      this.getProfileViewsListCacheKey(userId, limit),
      PROFILE_VIEWS_LIST_CACHE_TTL_SECONDS,
      async () => {
        const blockedUserIds =
          await this.blocksService.getBlockedRelationUserIds(userId);

        const rows = await this.db
          .select({
            id: profileViews.id,
            createdAt: profileViews.createdAt,
            viewerId: users.id,
            viewerFirstName: users.firstName,
            viewerLastName: users.lastName,
            viewerGender: users.gender,
            viewerBirthDate: users.birthDate,
          })
          .from(profileViews)
          .innerJoin(users, eq(users.id, profileViews.viewerId))
          .where(
            and(
              eq(profileViews.viewedId, userId),
              eq(users.isActive, true),
              isNull(users.deletedAt),
              blockedUserIds.length > 0
                ? notInArray(users.id, blockedUserIds)
                : undefined,
            ),
          )
          .orderBy(desc(profileViews.createdAt))
          .limit(limit);

        if (rows.length === 0) {
          return {
            count: 0,
            profileViews: [],
          };
        }

        const viewerIds = Array.from(new Set(rows.map((row) => row.viewerId)));
        const photos = await this.db
          .select({
            id: userPhotos.id,
            userId: userPhotos.userId,
            url: userPhotos.url,
            position: userPhotos.position,
          })
          .from(userPhotos)
          .where(inArray(userPhotos.userId, viewerIds))
          .orderBy(asc(userPhotos.position), asc(userPhotos.createdAt));

        const firstPhotoByUserId = new Map<
          string,
          { id: string; url: string }
        >();

        for (const photo of photos) {
          if (!firstPhotoByUserId.has(photo.userId)) {
            firstPhotoByUserId.set(photo.userId, {
              id: photo.id,
              url: photo.url,
            });
          }
        }

        return {
          count: rows.length,
          profileViews: rows.map((row) => ({
            id: row.id,
            createdAt: row.createdAt,
            viewer: {
              id: row.viewerId,
              firstName: row.viewerFirstName,
              lastName: row.viewerLastName,
              gender: row.viewerGender,
              age: this.calculateAge(row.viewerBirthDate),
              photo: firstPhotoByUserId.get(row.viewerId) ?? null,
            },
          })),
        };
      },
    );
  }

  async getProfileViewsCount(userId: string) {
    const user = await this.ensureUserExists(userId);
    const effectiveTier = this.subscriptionPolicyService.resolveEffectiveTier(
      user.subscriptionTier,
      user.subscriptionExpiresAt,
    );

    const count = await this.appCacheService.getOrSet(
      this.getProfileViewsCountCacheKey(userId),
      PROFILE_VIEWS_COUNT_CACHE_TTL_SECONDS,
      async () => {
        const blockedUserIds =
          await this.blocksService.getBlockedRelationUserIds(userId);

        const [countRow] = await this.db
          .select({
            count: sql<number>`count(*)`,
          })
          .from(profileViews)
          .innerJoin(users, eq(users.id, profileViews.viewerId))
          .where(
            and(
              eq(profileViews.viewedId, userId),
              eq(users.isActive, true),
              isNull(users.deletedAt),
              blockedUserIds.length > 0
                ? notInArray(profileViews.viewerId, blockedUserIds)
                : undefined,
            ),
          );

        return Number(countRow?.count ?? 0);
      },
    );

    return {
      count,
      tier: effectiveTier,
      canViewDetails: effectiveTier === 'premium',
    };
  }

  async recordView(
    viewerId: string,
    viewedId: string,
    tx: ReadWriteClient = this.db,
  ): Promise<boolean> {
    if (viewerId === viewedId) {
      return false;
    }

    const [existingTodayView] = await tx
      .select({
        id: profileViews.id,
      })
      .from(profileViews)
      .where(
        and(
          eq(profileViews.viewerId, viewerId),
          eq(profileViews.viewedId, viewedId),
          gte(profileViews.createdAt, this.getUtcDayStart()),
        ),
      )
      .limit(1);

    if (existingTodayView) {
      return false;
    }

    await tx
      .insert(profileViews)
      .values({
        viewerId,
        viewedId,
      })
      .onConflictDoNothing();

    return true;
  }

  private async ensureUserExists(userId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        subscriptionTier: users.subscriptionTier,
        subscriptionExpiresAt: users.subscriptionExpiresAt,
      })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.isActive, true),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return user;
  }

  private calculateAge(birthDate: string): number {
    const birth = new Date(birthDate);
    const now = new Date();

    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const hasBirthdayPassedThisYear =
      now.getUTCMonth() > birth.getUTCMonth() ||
      (now.getUTCMonth() === birth.getUTCMonth() &&
        now.getUTCDate() >= birth.getUTCDate());

    if (!hasBirthdayPassedThisYear) {
      age -= 1;
    }

    return age;
  }

  private resolveLimit(requestedLimit?: number): number {
    if (!requestedLimit) {
      return DEFAULT_PROFILE_VIEWS_LIMIT;
    }

    return Math.min(Math.max(requestedLimit, 1), MAX_PROFILE_VIEWS_LIMIT);
  }

  private getProfileViewsListCacheKey(userId: string, limit: number): string {
    return `profile-views:list:${userId}:${limit}`;
  }

  private getProfileViewsCountCacheKey(userId: string): string {
    return `profile-views:count:${userId}`;
  }

  private getUtcDayStart(): Date {
    const now = new Date();

    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
}
