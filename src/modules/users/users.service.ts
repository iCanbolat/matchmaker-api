import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppCacheService } from '../../common/performance/app-cache.service';
import { DatabaseService } from '../../database/database.service';
import { referrals, userPhotos, users } from '../../database/schema';
import { UpdateProfileDto } from './dto/update-profile.dto';

const USER_ME_CACHE_TTL_SECONDS = 30;

@Injectable()
export class UsersService {
  constructor(
    private readonly appCacheService: AppCacheService,
    private readonly databaseService: DatabaseService,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async getMe(userId: string) {
    return this.appCacheService.getOrSet(
      this.getMeCacheKey(userId),
      USER_ME_CACHE_TTL_SECONDS,
      async () => {
        const [user] = await this.db
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            birthDate: users.birthDate,
            gender: users.gender,
            bio: users.bio,
            referralCode: users.referralCode,
            referredBy: users.referredBy,
            isVerified: users.isVerified,
            isFrozen: users.isFrozen,
            subscriptionTier: users.subscriptionTier,
            createdAt: users.createdAt,
            updatedAt: users.updatedAt,
          })
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .limit(1);

        if (!user) {
          throw new NotFoundException('User not found.');
        }

        return {
          ...user,
          photos: await this.getPhotosByUserId(userId),
        };
      },
    );
  }

  async getMyReferralCode(userId: string) {
    const [user] = await this.db
      .select({
        referralCode: users.referralCode,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return {
      referralCode: user.referralCode,
    };
  }

  async getMyReferrals(userId: string) {
    await this.ensureUserExists(userId);

    const rows = await this.db
      .select({
        id: referrals.id,
        referralCodeUsed: referrals.referralCodeUsed,
        status: referrals.status,
        bonusType: referrals.bonusType,
        bonusValue: referrals.bonusValue,
        createdAt: referrals.createdAt,
        referredUserId: users.id,
        referredUserEmail: users.email,
        referredUserFirstName: users.firstName,
        referredUserLastName: users.lastName,
      })
      .from(referrals)
      .innerJoin(users, eq(users.id, referrals.referredId))
      .where(and(eq(referrals.referrerId, userId), isNull(users.deletedAt)))
      .orderBy(desc(referrals.createdAt));

    return {
      total: rows.length,
      referrals: rows.map((row) => ({
        id: row.id,
        referralCodeUsed: row.referralCodeUsed,
        status: row.status,
        bonusType: row.bonusType,
        bonusValue: row.bonusValue,
        createdAt: row.createdAt,
        referredUser: {
          id: row.referredUserId,
          email: row.referredUserEmail,
          firstName: row.referredUserFirstName,
          lastName: row.referredUserLastName,
        },
      })),
    };
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    const values: Partial<typeof users.$inferInsert> = {};

    if (dto.firstName !== undefined) {
      values.firstName = dto.firstName;
    }

    if (dto.lastName !== undefined) {
      values.lastName = dto.lastName;
    }

    if (dto.bio !== undefined) {
      values.bio = dto.bio;
    }

    if (dto.birthDate !== undefined) {
      values.birthDate = dto.birthDate;
    }

    if (dto.gender !== undefined) {
      values.gender = dto.gender;
    }

    if (Object.keys(values).length > 0) {
      values.updatedAt = new Date();

      await this.db.update(users).set(values).where(eq(users.id, userId));
    }

    await this.invalidateUserProfileCache(userId);

    return this.getMe(userId);
  }

  async addPhoto(userId: string, url: string) {
    await this.ensureUserExists(userId);

    const [positionRow] = await this.db
      .select({
        maxPosition: sql<number>`coalesce(max(${userPhotos.position}), -1)`,
      })
      .from(userPhotos)
      .where(eq(userPhotos.userId, userId));

    const position = Number(positionRow?.maxPosition ?? -1) + 1;

    const [photo] = await this.db
      .insert(userPhotos)
      .values({
        userId,
        url,
        position,
      })
      .returning({
        id: userPhotos.id,
        url: userPhotos.url,
        position: userPhotos.position,
        createdAt: userPhotos.createdAt,
      });

    await this.invalidateUserProfileCache(userId);

    return photo;
  }

  async deletePhoto(userId: string, photoId: string) {
    await this.ensureUserExists(userId);

    const [photo] = await this.db
      .select({
        id: userPhotos.id,
        url: userPhotos.url,
      })
      .from(userPhotos)
      .where(and(eq(userPhotos.id, photoId), eq(userPhotos.userId, userId)))
      .limit(1);

    if (!photo) {
      throw new NotFoundException('Photo not found.');
    }

    await this.db.delete(userPhotos).where(eq(userPhotos.id, photo.id));
    await this.reindexPhotoPositions(userId);
    await this.invalidateUserProfileCache(userId);

    return photo;
  }

  async reorderPhotos(userId: string, photoIds: string[]) {
    await this.ensureUserExists(userId);

    const currentPhotos = await this.getPhotosByUserId(userId);

    if (currentPhotos.length !== photoIds.length) {
      throw new BadRequestException('All user photos must be provided.');
    }

    const currentPhotoIds = new Set(currentPhotos.map((photo) => photo.id));
    const includesUnknownPhoto = photoIds.some((photoId) => {
      return !currentPhotoIds.has(photoId);
    });

    if (includesUnknownPhoto) {
      throw new BadRequestException('Photo list contains unknown ids.');
    }

    await this.db.transaction(async (tx) => {
      for (const [position, photoId] of photoIds.entries()) {
        await tx
          .update(userPhotos)
          .set({ position })
          .where(
            and(eq(userPhotos.id, photoId), eq(userPhotos.userId, userId)),
          );
      }
    });

    await this.invalidateUserProfileCache(userId);

    return this.getPhotosByUserId(userId);
  }

  async freezeAccount(userId: string) {
    await this.ensureUserExists(userId);

    await this.db
      .update(users)
      .set({
        isFrozen: true,
        frozenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await this.invalidateUserProfileCache(userId);

    return { message: 'Account frozen successfully.' };
  }

  async unfreezeAccount(userId: string) {
    await this.ensureUserExists(userId);

    await this.db
      .update(users)
      .set({
        isFrozen: false,
        frozenAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await this.invalidateUserProfileCache(userId);

    return { message: 'Account unfrozen successfully.' };
  }

  async deleteAccount(userId: string) {
    await this.ensureUserExists(userId);

    await this.db
      .update(users)
      .set({
        deletedAt: new Date(),
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await this.invalidateUserProfileCache(userId);

    return { message: 'Account deleted successfully.' };
  }

  private async getPhotosByUserId(userId: string) {
    return this.db
      .select({
        id: userPhotos.id,
        url: userPhotos.url,
        position: userPhotos.position,
        createdAt: userPhotos.createdAt,
      })
      .from(userPhotos)
      .where(eq(userPhotos.userId, userId))
      .orderBy(asc(userPhotos.position), asc(userPhotos.createdAt));
  }

  private async reindexPhotoPositions(userId: string): Promise<void> {
    const currentPhotos = await this.getPhotosByUserId(userId);

    await this.db.transaction(async (tx) => {
      for (const [position, photo] of currentPhotos.entries()) {
        await tx
          .update(userPhotos)
          .set({ position })
          .where(
            and(eq(userPhotos.id, photo.id), eq(userPhotos.userId, userId)),
          );
      }
    });
  }

  private async invalidateUserProfileCache(userId: string): Promise<void> {
    await this.appCacheService.del(this.getMeCacheKey(userId));
  }

  private getMeCacheKey(userId: string): string {
    return `users:me:${userId}`;
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const [existingUser] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!existingUser) {
      throw new NotFoundException('User not found.');
    }
  }
}
