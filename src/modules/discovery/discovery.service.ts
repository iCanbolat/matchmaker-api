import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { matches, swipes, userPhotos, users } from '../../database/schema';
import { ReferralBonusService } from '../referrals/referral-bonus.service';
import {
  type SwipeDirection,
  type SwipeDto,
  SWIPE_DIRECTIONS,
} from './dto/swipe.dto';

type SubscriptionTier = 'free' | 'plus' | 'premium';

type DailySwipeLimit = number | null;

type DiscoveryCard = {
  id: string;
  firstName: string;
  lastName: string | null;
  age: number;
  gender: string;
  bio: string | null;
  photos: Array<{
    id: string;
    url: string;
    position: number;
  }>;
};

type MatchSummary = {
  id: string;
  user1Id: string;
  user2Id: string;
  matchedAt: Date;
};

type TransactionClient = {
  select: DatabaseService['db']['select'];
  insert: DatabaseService['db']['insert'];
};

const DAILY_SWIPE_LIMITS: Record<SubscriptionTier, DailySwipeLimit> = {
  free: 20,
  plus: 100,
  premium: null,
};

const DEFAULT_DISCOVERY_CARDS_LIMIT = 20;
const MAX_DISCOVERY_CARDS_LIMIT = 50;
const COUNTED_SWIPE_DIRECTIONS: Array<(typeof SWIPE_DIRECTIONS)[number]> = [
  'like',
  'super_like',
];
const MATCH_TRIGGER_DIRECTIONS: Array<(typeof SWIPE_DIRECTIONS)[number]> = [
  'like',
  'super_like',
];

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly referralBonusService: ReferralBonusService,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async getCards(
    userId: string,
    requestedLimit?: number,
  ): Promise<{ count: number; cards: DiscoveryCard[] }> {
    const limit = this.resolveCardsLimit(requestedLimit);

    await this.assertUserCanUseDiscovery(userId);

    const candidates = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        birthDate: users.birthDate,
        gender: users.gender,
        bio: users.bio,
      })
      .from(users)
      .where(
        and(
          ne(users.id, userId),
          isNull(users.deletedAt),
          eq(users.isActive, true),
          eq(users.isFrozen, false),
          eq(users.isVerified, true),
          sql`not exists (
            select 1
            from swipes s
            where s.swiper_id = ${userId}
              and s.swiped_id = ${users.id}
              and s.is_undone = false
          )`,
        ),
      )
      .orderBy(desc(users.createdAt))
      .limit(limit);

    if (candidates.length === 0) {
      return {
        count: 0,
        cards: [],
      };
    }

    const candidateIds = candidates.map((candidate) => candidate.id);
    const photos = await this.db
      .select({
        id: userPhotos.id,
        userId: userPhotos.userId,
        url: userPhotos.url,
        position: userPhotos.position,
      })
      .from(userPhotos)
      .where(inArray(userPhotos.userId, candidateIds))
      .orderBy(asc(userPhotos.position), asc(userPhotos.createdAt));

    const photosByUserId = new Map<
      string,
      Array<{ id: string; url: string; position: number }>
    >();

    for (const photo of photos) {
      const existingPhotos = photosByUserId.get(photo.userId) ?? [];

      existingPhotos.push({
        id: photo.id,
        url: photo.url,
        position: photo.position,
      });

      photosByUserId.set(photo.userId, existingPhotos);
    }

    const cards = candidates.map((candidate) => ({
      id: candidate.id,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      age: this.calculateAge(candidate.birthDate),
      gender: candidate.gender,
      bio: candidate.bio,
      photos: photosByUserId.get(candidate.id) ?? [],
    }));

    return {
      count: cards.length,
      cards,
    };
  }

  async swipe(swiperId: string, dto: SwipeDto) {
    if (swiperId === dto.swipedUserId) {
      throw new BadRequestException('You cannot swipe yourself.');
    }

    return this.db.transaction(async (tx) => {
      const [swiper] = await tx
        .select({
          id: users.id,
          subscriptionTier: users.subscriptionTier,
          subscriptionExpiresAt: users.subscriptionExpiresAt,
        })
        .from(users)
        .where(
          and(
            eq(users.id, swiperId),
            isNull(users.deletedAt),
            eq(users.isActive, true),
            eq(users.isFrozen, false),
          ),
        )
        .limit(1);

      if (!swiper) {
        throw new NotFoundException('User not found.');
      }

      const [target] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, dto.swipedUserId),
            isNull(users.deletedAt),
            eq(users.isActive, true),
            eq(users.isFrozen, false),
          ),
        )
        .limit(1);

      if (!target) {
        throw new NotFoundException('Target user not found.');
      }

      const effectiveTier = this.resolveEffectiveTier(
        swiper.subscriptionTier,
        swiper.subscriptionExpiresAt,
      );
      const dailySwipeLimit = DAILY_SWIPE_LIMITS[effectiveTier];
      let usedReferralCredit = false;

      if (this.isCountedDirection(dto.direction) && dailySwipeLimit !== null) {
        const [todaySwipeCountRow] = await tx
          .select({
            count: sql<number>`count(*)`,
          })
          .from(swipes)
          .where(
            and(
              eq(swipes.swiperId, swiperId),
              eq(swipes.isUndone, false),
              gte(swipes.createdAt, this.getUtcDayStart()),
              inArray(swipes.direction, this.getCountedDirections()),
            ),
          );

        const todaySwipeCount = Number(todaySwipeCountRow?.count ?? 0);

        if (todaySwipeCount >= dailySwipeLimit) {
          usedReferralCredit =
            await this.referralBonusService.consumeSwipeCredit(tx, swiperId);

          if (!usedReferralCredit) {
            throw new ForbiddenException(
              'Daily swipe limit reached. Upgrade to Plus/Premium or earn referral swipe credits.',
            );
          }
        }
      }

      const [swipe] = await tx
        .insert(swipes)
        .values({
          swiperId,
          swipedId: dto.swipedUserId,
          direction: dto.direction,
          isUndone: false,
        })
        .onConflictDoNothing()
        .returning({
          id: swipes.id,
          swipedUserId: swipes.swipedId,
          direction: swipes.direction,
          createdAt: swipes.createdAt,
        });

      if (!swipe) {
        throw new BadRequestException('You have already swiped this user.');
      }

      const match = await this.tryCreateMatch(
        tx,
        swiperId,
        dto.swipedUserId,
        dto.direction,
      );

      const remainingSwipeCredits =
        await this.referralBonusService.getRemainingSwipeCredits(tx, swiperId);

      return {
        swipe,
        match,
        limit: {
          tier: effectiveTier,
          dailySwipeLimit,
          usedReferralCredit,
          remainingSwipeCredits,
        },
      };
    });
  }

  async getSwipeLimitStatus(userId: string) {
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
          isNull(users.deletedAt),
          eq(users.isActive, true),
          eq(users.isFrozen, false),
        ),
      )
      .limit(1);

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const effectiveTier = this.resolveEffectiveTier(
      user.subscriptionTier,
      user.subscriptionExpiresAt,
    );
    const dailySwipeLimit = DAILY_SWIPE_LIMITS[effectiveTier];

    let todaySwipeCount = 0;

    if (dailySwipeLimit !== null) {
      const [todaySwipeCountRow] = await this.db
        .select({
          count: sql<number>`count(*)`,
        })
        .from(swipes)
        .where(
          and(
            eq(swipes.swiperId, userId),
            eq(swipes.isUndone, false),
            gte(swipes.createdAt, this.getUtcDayStart()),
            inArray(swipes.direction, this.getCountedDirections()),
          ),
        );

      todaySwipeCount = Number(todaySwipeCountRow?.count ?? 0);
    }

    const remainingSwipeCredits =
      await this.referralBonusService.getRemainingSwipeCredits(this.db, userId);

    return {
      tier: effectiveTier,
      dailySwipeLimit,
      todaySwipeCount,
      dailyRemaining:
        dailySwipeLimit === null
          ? null
          : Math.max(dailySwipeLimit - todaySwipeCount, 0),
      referralSwipeCreditsRemaining: remainingSwipeCredits,
    };
  }

  private resolveEffectiveTier(
    subscriptionTier: string,
    subscriptionExpiresAt: Date | null,
  ): SubscriptionTier {
    if (subscriptionTier !== 'plus' && subscriptionTier !== 'premium') {
      return 'free';
    }

    if (!subscriptionExpiresAt || subscriptionExpiresAt <= new Date()) {
      return 'free';
    }

    return subscriptionTier;
  }

  private async tryCreateMatch(
    tx: TransactionClient,
    swiperId: string,
    swipedUserId: string,
    direction: SwipeDirection,
  ): Promise<MatchSummary | null> {
    if (!this.isMatchTriggerDirection(direction)) {
      return null;
    }

    const [reciprocalSwipe] = await tx
      .select({ id: swipes.id })
      .from(swipes)
      .where(
        and(
          eq(swipes.swiperId, swipedUserId),
          eq(swipes.swipedId, swiperId),
          eq(swipes.isUndone, false),
          inArray(swipes.direction, this.getMatchTriggerDirections()),
        ),
      )
      .limit(1);

    if (!reciprocalSwipe) {
      return null;
    }

    const pair = this.toCanonicalMatchPair(swiperId, swipedUserId);

    const [createdMatch] = await tx
      .insert(matches)
      .values({
        user1Id: pair.user1Id,
        user2Id: pair.user2Id,
        isActive: true,
      })
      .onConflictDoNothing()
      .returning({
        id: matches.id,
        user1Id: matches.user1Id,
        user2Id: matches.user2Id,
        matchedAt: matches.matchedAt,
      });

    if (createdMatch) {
      return createdMatch;
    }

    const [existingActiveMatch] = await tx
      .select({
        id: matches.id,
        user1Id: matches.user1Id,
        user2Id: matches.user2Id,
        matchedAt: matches.matchedAt,
      })
      .from(matches)
      .where(
        and(
          eq(matches.user1Id, pair.user1Id),
          eq(matches.user2Id, pair.user2Id),
          eq(matches.isActive, true),
        ),
      )
      .limit(1);

    return existingActiveMatch ?? null;
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

  private async assertUserCanUseDiscovery(userId: string): Promise<void> {
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

  private resolveCardsLimit(requestedLimit?: number): number {
    if (!requestedLimit) {
      return DEFAULT_DISCOVERY_CARDS_LIMIT;
    }

    return Math.min(Math.max(requestedLimit, 1), MAX_DISCOVERY_CARDS_LIMIT);
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

  private isCountedDirection(direction: SwipeDirection): boolean {
    return this.getCountedDirections().includes(direction);
  }

  private isMatchTriggerDirection(direction: SwipeDirection): boolean {
    return this.getMatchTriggerDirections().includes(direction);
  }

  private getCountedDirections(): Array<(typeof SWIPE_DIRECTIONS)[number]> {
    return COUNTED_SWIPE_DIRECTIONS;
  }

  private getMatchTriggerDirections(): Array<
    (typeof SWIPE_DIRECTIONS)[number]
  > {
    return MATCH_TRIGGER_DIRECTIONS;
  }

  private getUtcDayStart(): Date {
    const now = new Date();

    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
}
