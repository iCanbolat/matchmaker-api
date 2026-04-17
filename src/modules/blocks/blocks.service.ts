import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { AppCacheService } from '../../common/performance/app-cache.service';
import { DatabaseService } from '../../database/database.service';
import { blocks, matches, userPhotos, users } from '../../database/schema';

const DEFAULT_BLOCKS_LIMIT = 50;
const MAX_BLOCKS_LIMIT = 200;
const BLOCKS_LIST_CACHE_TTL_SECONDS = 20;
const BLOCK_RELATIONS_CACHE_TTL_SECONDS = 15;

@Injectable()
export class BlocksService {
  constructor(
    private readonly appCacheService: AppCacheService,
    private readonly databaseService: DatabaseService,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async listBlockedUsers(blockerId: string, requestedLimit?: number) {
    await this.ensureUserExists(blockerId);

    const limit = this.resolveLimit(requestedLimit);

    return this.appCacheService.getOrSet(
      this.getBlocksListCacheKey(blockerId, limit),
      BLOCKS_LIST_CACHE_TTL_SECONDS,
      async () => {
        const rows = await this.db
          .select({
            id: blocks.id,
            blockedAt: blocks.createdAt,
            blockedUserId: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            birthDate: users.birthDate,
            gender: users.gender,
            bio: users.bio,
          })
          .from(blocks)
          .innerJoin(users, eq(users.id, blocks.blockedId))
          .where(
            and(
              eq(blocks.blockerId, blockerId),
              isNull(users.deletedAt),
              eq(users.isActive, true),
            ),
          )
          .orderBy(desc(blocks.createdAt))
          .limit(limit);

        if (rows.length === 0) {
          return {
            count: 0,
            blockedUsers: [],
          };
        }

        const blockedUserIds = rows.map((row) => row.blockedUserId);
        const photos = await this.db
          .select({
            userId: userPhotos.userId,
            id: userPhotos.id,
            url: userPhotos.url,
            position: userPhotos.position,
          })
          .from(userPhotos)
          .where(inArray(userPhotos.userId, blockedUserIds))
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
          blockedUsers: rows.map((row) => ({
            id: row.id,
            blockedAt: row.blockedAt,
            user: {
              id: row.blockedUserId,
              firstName: row.firstName,
              lastName: row.lastName,
              gender: row.gender,
              bio: row.bio,
              age: this.calculateAge(row.birthDate),
              photo: firstPhotoByUserId.get(row.blockedUserId) ?? null,
            },
          })),
        };
      },
    );
  }

  async blockUser(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new BadRequestException('You cannot block yourself.');
    }

    await this.ensureUserExists(blockerId);
    await this.ensureUserExists(blockedId);

    const [created] = await this.db
      .insert(blocks)
      .values({
        blockerId,
        blockedId,
      })
      .onConflictDoNothing()
      .returning({
        id: blocks.id,
        blockerId: blocks.blockerId,
        blockedId: blocks.blockedId,
        createdAt: blocks.createdAt,
      });

    const blockRecord =
      created ?? (await this.getBlockRecord(blockerId, blockedId));

    if (!blockRecord) {
      throw new BadRequestException('Failed to block user.');
    }

    const deactivatedMatchCount = await this.deactivateMatchesBetweenUsers(
      blockerId,
      blockedId,
    );

    await this.invalidateBlockRelatedCaches(blockerId, blockedId);

    return {
      id: blockRecord.id,
      blockedUserId: blockRecord.blockedId,
      createdAt: blockRecord.createdAt,
      alreadyBlocked: !created,
      deactivatedMatchCount,
    };
  }

  async unblockUser(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new BadRequestException('You cannot unblock yourself.');
    }

    await this.ensureUserExists(blockerId);

    const rows = await this.db
      .delete(blocks)
      .where(
        and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)),
      )
      .returning({
        id: blocks.id,
      });

    if (rows.length === 0) {
      throw new NotFoundException('Block not found.');
    }

    await this.invalidateBlockRelatedCaches(blockerId, blockedId);

    return {
      blockedUserId: blockedId,
      removed: true,
    };
  }

  async isEitherUserBlocked(
    userAId: string,
    userBId: string,
  ): Promise<boolean> {
    if (userAId === userBId) {
      return false;
    }

    const relatedUserIds = await this.getBlockedRelationUserIds(userAId);
    return relatedUserIds.includes(userBId);
  }

  async getBlockedRelationUserIds(userId: string): Promise<string[]> {
    return this.appCacheService.getOrSet(
      this.getBlockedRelationsCacheKey(userId),
      BLOCK_RELATIONS_CACHE_TTL_SECONDS,
      async () => {
        const rows = await this.db
          .select({
            blockerId: blocks.blockerId,
            blockedId: blocks.blockedId,
          })
          .from(blocks)
          .where(
            or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)),
          );

        const relatedUserIds = new Set<string>();

        for (const row of rows) {
          relatedUserIds.add(
            row.blockerId === userId ? row.blockedId : row.blockerId,
          );
        }

        return Array.from(relatedUserIds);
      },
    );
  }

  private async getBlockRecord(blockerId: string, blockedId: string) {
    const [blockRecord] = await this.db
      .select({
        id: blocks.id,
        blockerId: blocks.blockerId,
        blockedId: blocks.blockedId,
        createdAt: blocks.createdAt,
      })
      .from(blocks)
      .where(
        and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)),
      )
      .limit(1);

    return blockRecord ?? null;
  }

  private async deactivateMatchesBetweenUsers(
    firstUserId: string,
    secondUserId: string,
  ): Promise<number> {
    const pair = this.toCanonicalMatchPair(firstUserId, secondUserId);

    const rows = await this.db
      .update(matches)
      .set({
        isActive: false,
      })
      .where(
        and(
          eq(matches.user1Id, pair.user1Id),
          eq(matches.user2Id, pair.user2Id),
          eq(matches.isActive, true),
        ),
      )
      .returning({
        id: matches.id,
      });

    return rows.length;
  }

  private async invalidateBlockRelatedCaches(
    firstUserId: string,
    secondUserId: string,
  ): Promise<void> {
    await Promise.all([
      this.appCacheService.del(this.getBlockedRelationsCacheKey(firstUserId)),
      this.appCacheService.del(this.getBlockedRelationsCacheKey(secondUserId)),
      this.appCacheService.delByPrefix(
        this.getBlocksListCachePrefix(firstUserId),
      ),
      this.appCacheService.delByPrefix(
        this.getBlocksListCachePrefix(secondUserId),
      ),
      this.invalidateUserInteractionCaches(firstUserId),
      this.invalidateUserInteractionCaches(secondUserId),
    ]);
  }

  private async invalidateUserInteractionCaches(userId: string): Promise<void> {
    await Promise.all([
      this.appCacheService.delByPrefix(
        this.getDiscoveryCardsCachePrefix(userId),
      ),
      this.appCacheService.del(this.getMatchesListCacheKey(userId)),
      this.appCacheService.delByPrefix(
        this.getProfileViewsListCachePrefix(userId),
      ),
      this.appCacheService.del(this.getProfileViewsCountCacheKey(userId)),
    ]);
  }

  private getBlockedRelationsCacheKey(userId: string): string {
    return `blocks:related:${userId}`;
  }

  private getBlocksListCacheKey(userId: string, limit: number): string {
    return `blocks:list:${userId}:${limit}`;
  }

  private getBlocksListCachePrefix(userId: string): string {
    return `blocks:list:${userId}:`;
  }

  private getDiscoveryCardsCachePrefix(userId: string): string {
    return `discovery:cards:${userId}:`;
  }

  private getMatchesListCacheKey(userId: string): string {
    return `matches:list:${userId}`;
  }

  private getProfileViewsListCachePrefix(userId: string): string {
    return `profile-views:list:${userId}:`;
  }

  private getProfileViewsCountCacheKey(userId: string): string {
    return `profile-views:count:${userId}`;
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          isNull(users.deletedAt),
          eq(users.isActive, true),
          eq(users.isFrozen, false),
        ),
      )
      .limit(1);

    if (!user) {
      throw new NotFoundException('User not found.');
    }
  }

  private toCanonicalMatchPair(
    firstUserId: string,
    secondUserId: string,
  ): { user1Id: string; user2Id: string } {
    if (firstUserId < secondUserId) {
      return {
        user1Id: firstUserId,
        user2Id: secondUserId,
      };
    }

    return {
      user1Id: secondUserId,
      user2Id: firstUserId,
    };
  }

  private resolveLimit(requestedLimit?: number): number {
    if (!requestedLimit) {
      return DEFAULT_BLOCKS_LIMIT;
    }

    return Math.min(Math.max(requestedLimit, 1), MAX_BLOCKS_LIMIT);
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
}
