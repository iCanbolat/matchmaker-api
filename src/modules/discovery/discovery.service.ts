import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  conversations,
  matches,
  swipes,
  userBoosts,
  userPhotos,
  users,
} from '../../database/schema';
import { NotificationsService } from '../notifications/notifications.service';
import { ProfileViewsService } from '../profile-views/profile-views.service';
import { ReferralBonusService } from '../referrals/referral-bonus.service';
import { SubscriptionPolicyService } from '../subscriptions/subscription-policy.service';
import {
  type SwipeDirection,
  type SwipeDto,
  SWIPE_DIRECTIONS,
} from './dto/swipe.dto';

type DiscoveryCard = {
  id: string;
  firstName: string;
  lastName: string | null;
  age: number;
  gender: string;
  bio: string | null;
  isBoosted: boolean;
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

type MatchCreationResult = {
  match: MatchSummary | null;
  created: boolean;
};

type TransactionClient = {
  select: DatabaseService['db']['select'];
  insert: DatabaseService['db']['insert'];
  update: DatabaseService['db']['update'];
};

type SelectClient = {
  select: DatabaseService['db']['select'];
};

const DEFAULT_DISCOVERY_CARDS_LIMIT = 20;
const MAX_DISCOVERY_CARDS_LIMIT = 50;
const BOOST_DURATION_MINUTES = 30;
const MATCH_TRIGGER_DIRECTIONS: Array<(typeof SWIPE_DIRECTIONS)[number]> = [
  'like',
  'super_like',
];

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly referralBonusService: ReferralBonusService,
    private readonly notificationsService: NotificationsService,
    private readonly profileViewsService: ProfileViewsService,
    private readonly subscriptionPolicyService: SubscriptionPolicyService,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async getCards(
    userId: string,
    requestedLimit?: number,
  ): Promise<{ count: number; cards: DiscoveryCard[] }> {
    const limit = this.resolveCardsLimit(requestedLimit);
    const boostRank = sql<number>`
      case when exists (
        select 1
        from user_boosts ub
        where ub.user_id = ${users.id}
          and ub.starts_at <= now()
          and ub.expires_at > now()
      ) then 1 else 0 end
    `;

    await this.assertUserCanUseDiscovery(userId);

    const candidates = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        birthDate: users.birthDate,
        gender: users.gender,
        bio: users.bio,
        boostRank,
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
      .orderBy(desc(boostRank), desc(users.createdAt))
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
      isBoosted: Number(candidate.boostRank ?? 0) > 0,
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

    const result = await this.db.transaction(async (tx) => {
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

      const effectiveTier = this.subscriptionPolicyService.resolveEffectiveTier(
        swiper.subscriptionTier,
        swiper.subscriptionExpiresAt,
      );
      const limits =
        this.subscriptionPolicyService.getLimitsForTier(effectiveTier);
      const dailyLikeLimit = limits.dailyLikeLimit;
      const dailySuperLikeLimit = limits.dailySuperLikeLimit;
      let usedReferralCredit = false;
      let todayLikeCount: number | null = null;
      let todaySuperLikeCount: number | null = null;

      if (dto.direction === 'like' && dailyLikeLimit !== null) {
        todayLikeCount = await this.countTodaySwipeByDirection(
          tx,
          swiperId,
          'like',
        );

        if (todayLikeCount >= dailyLikeLimit) {
          usedReferralCredit =
            await this.referralBonusService.consumeSwipeCredit(tx, swiperId);

          if (!usedReferralCredit) {
            throw new ForbiddenException(
              'Daily swipe limit reached. Upgrade to Plus/Premium or earn referral swipe credits.',
            );
          }
        }
      }

      if (dto.direction === 'super_like' && dailySuperLikeLimit !== null) {
        todaySuperLikeCount = await this.countTodaySwipeByDirection(
          tx,
          swiperId,
          'super_like',
        );

        if (todaySuperLikeCount >= dailySuperLikeLimit) {
          throw new ForbiddenException(
            'Daily super like limit reached. Upgrade your subscription to increase limits.',
          );
        }
      }

      await this.profileViewsService.recordView(swiperId, dto.swipedUserId, tx);

      const [existingSwipe] = await tx
        .select({
          id: swipes.id,
          isUndone: swipes.isUndone,
        })
        .from(swipes)
        .where(
          and(
            eq(swipes.swiperId, swiperId),
            eq(swipes.swipedId, dto.swipedUserId),
          ),
        )
        .limit(1);

      let swipe:
        | {
            id: string;
            swipedUserId: string;
            direction: string;
            createdAt: Date;
          }
        | undefined;

      if (!existingSwipe) {
        [swipe] = await tx
          .insert(swipes)
          .values({
            swiperId,
            swipedId: dto.swipedUserId,
            direction: dto.direction,
            isUndone: false,
            undoneAt: null,
          })
          .returning({
            id: swipes.id,
            swipedUserId: swipes.swipedId,
            direction: swipes.direction,
            createdAt: swipes.createdAt,
          });
      } else {
        if (!existingSwipe.isUndone) {
          throw new BadRequestException('You have already swiped this user.');
        }

        [swipe] = await tx
          .update(swipes)
          .set({
            direction: dto.direction,
            isUndone: false,
            undoneAt: null,
            createdAt: new Date(),
          })
          .where(eq(swipes.id, existingSwipe.id))
          .returning({
            id: swipes.id,
            swipedUserId: swipes.swipedId,
            direction: swipes.direction,
            createdAt: swipes.createdAt,
          });
      }

      if (!swipe) {
        throw new BadRequestException('Failed to save swipe.');
      }

      const matchResult = await this.tryCreateMatch(
        tx,
        swiperId,
        dto.swipedUserId,
        dto.direction,
      );

      const remainingSwipeCredits =
        await this.referralBonusService.getRemainingSwipeCredits(tx, swiperId);

      return {
        swipe,
        match: matchResult.match,
        matchCreated: matchResult.created,
        limit: {
          tier: effectiveTier,
          dailyLikeLimit,
          dailySuperLikeLimit,
          dailySwipeLimit: dailyLikeLimit,
          todayLikeCount,
          todaySuperLikeCount,
          usedReferralCredit,
          remainingSwipeCredits,
        },
      };
    });

    const { matchCreated, ...publicResult } = result;

    if (matchCreated && publicResult.match) {
      await this.notificationsService.notifyMatchCreated(
        publicResult.match.id,
        publicResult.match.user1Id,
        publicResult.match.user2Id,
      );
    }

    return publicResult;
  }

  async rewind(userId: string) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
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

      const effectiveTier = this.subscriptionPolicyService.resolveEffectiveTier(
        user.subscriptionTier,
        user.subscriptionExpiresAt,
      );
      const limits =
        this.subscriptionPolicyService.getLimitsForTier(effectiveTier);
      const dailyRewindLimit = limits.dailyRewindLimit;

      const todayRewindCount =
        dailyRewindLimit === null
          ? 0
          : await this.countTodayRewinds(tx, userId);

      if (dailyRewindLimit !== null && todayRewindCount >= dailyRewindLimit) {
        throw new ForbiddenException(
          'Daily rewind limit reached. Upgrade your subscription to increase limits.',
        );
      }

      const [lastSwipe] = await tx
        .select({
          id: swipes.id,
          swipedUserId: swipes.swipedId,
          direction: swipes.direction,
          createdAt: swipes.createdAt,
        })
        .from(swipes)
        .where(and(eq(swipes.swiperId, userId), eq(swipes.isUndone, false)))
        .orderBy(desc(swipes.createdAt))
        .limit(1);

      if (!lastSwipe) {
        throw new NotFoundException('No swipe available to rewind.');
      }

      const now = new Date();

      const [rewound] = await tx
        .update(swipes)
        .set({
          isUndone: true,
          undoneAt: now,
        })
        .where(eq(swipes.id, lastSwipe.id))
        .returning({
          id: swipes.id,
        });

      if (!rewound) {
        throw new BadRequestException('Failed to rewind swipe.');
      }

      const remainingSwipeCredits =
        await this.referralBonusService.getRemainingSwipeCredits(tx, userId);
      const updatedTodayRewindCount =
        dailyRewindLimit === null ? null : todayRewindCount + 1;

      return {
        rewoundSwipe: {
          id: lastSwipe.id,
          swipedUserId: lastSwipe.swipedUserId,
          direction: lastSwipe.direction,
          createdAt: lastSwipe.createdAt,
          rewoundAt: now,
        },
        limit: {
          tier: effectiveTier,
          dailyRewindLimit,
          todayRewindCount: updatedTodayRewindCount,
          dailyRewindRemaining:
            dailyRewindLimit === null
              ? null
              : Math.max(dailyRewindLimit - (todayRewindCount + 1), 0),
          remainingSwipeCredits,
        },
      };
    });
  }

  async boost(userId: string) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
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

      const effectiveTier = this.subscriptionPolicyService.resolveEffectiveTier(
        user.subscriptionTier,
        user.subscriptionExpiresAt,
      );
      const limits =
        this.subscriptionPolicyService.getLimitsForTier(effectiveTier);
      const monthlyBoostLimit = limits.monthlyBoostLimit;

      if (monthlyBoostLimit <= 0) {
        throw new ForbiddenException(
          'Boost is available for Plus and Premium members only.',
        );
      }

      const monthBoostCount = await this.countCurrentMonthBoosts(tx, userId);

      if (monthBoostCount >= monthlyBoostLimit) {
        throw new ForbiddenException(
          'Monthly boost limit reached. Upgrade your subscription to increase limits.',
        );
      }

      const now = new Date();
      const [activeBoost] = await tx
        .select({
          id: userBoosts.id,
          startsAt: userBoosts.startsAt,
          expiresAt: userBoosts.expiresAt,
        })
        .from(userBoosts)
        .where(
          and(
            eq(userBoosts.userId, userId),
            sql`${userBoosts.startsAt} <= ${now}`,
            gte(userBoosts.expiresAt, now),
          ),
        )
        .orderBy(desc(userBoosts.expiresAt))
        .limit(1);

      if (activeBoost && activeBoost.expiresAt > now) {
        throw new BadRequestException('You already have an active boost.');
      }

      const expiresAt = new Date(
        now.getTime() + BOOST_DURATION_MINUTES * 60_000,
      );

      const [createdBoost] = await tx
        .insert(userBoosts)
        .values({
          userId,
          startsAt: now,
          expiresAt,
        })
        .returning({
          id: userBoosts.id,
          startsAt: userBoosts.startsAt,
          expiresAt: userBoosts.expiresAt,
          createdAt: userBoosts.createdAt,
        });

      if (!createdBoost) {
        throw new BadRequestException('Failed to activate boost.');
      }

      return {
        boost: createdBoost,
        limit: {
          tier: effectiveTier,
          monthlyBoostLimit,
          monthBoostCount: monthBoostCount + 1,
          monthlyBoostRemaining: Math.max(
            monthlyBoostLimit - (monthBoostCount + 1),
            0,
          ),
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

    const effectiveTier = this.subscriptionPolicyService.resolveEffectiveTier(
      user.subscriptionTier,
      user.subscriptionExpiresAt,
    );
    const limits =
      this.subscriptionPolicyService.getLimitsForTier(effectiveTier);
    const dailyLikeLimit = limits.dailyLikeLimit;
    const dailySuperLikeLimit = limits.dailySuperLikeLimit;

    const todayLikeCount =
      dailyLikeLimit === null
        ? 0
        : await this.countTodaySwipeByDirection(this.db, userId, 'like');
    const todaySuperLikeCount =
      dailySuperLikeLimit === null
        ? 0
        : await this.countTodaySwipeByDirection(this.db, userId, 'super_like');
    const monthBoostCount = await this.countCurrentMonthBoosts(this.db, userId);

    const remainingSwipeCredits =
      await this.referralBonusService.getRemainingSwipeCredits(this.db, userId);

    return {
      tier: effectiveTier,
      dailyLikeLimit,
      dailySuperLikeLimit,
      dailyRewindLimit: limits.dailyRewindLimit,
      monthlyBoostLimit: limits.monthlyBoostLimit,
      dailySwipeLimit: dailyLikeLimit,
      todayLikeCount,
      todaySuperLikeCount,
      monthBoostCount,
      todaySwipeCount: todayLikeCount,
      dailyLikeRemaining:
        dailyLikeLimit === null
          ? null
          : Math.max(dailyLikeLimit - todayLikeCount, 0),
      dailySuperLikeRemaining:
        dailySuperLikeLimit === null
          ? null
          : Math.max(dailySuperLikeLimit - todaySuperLikeCount, 0),
      dailyRemaining:
        dailyLikeLimit === null
          ? null
          : Math.max(dailyLikeLimit - todayLikeCount, 0),
      monthlyBoostRemaining:
        limits.monthlyBoostLimit <= 0
          ? 0
          : Math.max(limits.monthlyBoostLimit - monthBoostCount, 0),
      referralSwipeCreditsRemaining: remainingSwipeCredits,
    };
  }

  private async tryCreateMatch(
    tx: TransactionClient,
    swiperId: string,
    swipedUserId: string,
    direction: SwipeDirection,
  ): Promise<MatchCreationResult> {
    if (!this.isMatchTriggerDirection(direction)) {
      return {
        match: null,
        created: false,
      };
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
      return {
        match: null,
        created: false,
      };
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
      await this.ensureConversationForMatch(tx, createdMatch.id);
      return {
        match: createdMatch,
        created: true,
      };
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

    if (existingActiveMatch) {
      await this.ensureConversationForMatch(tx, existingActiveMatch.id);
      return {
        match: existingActiveMatch,
        created: false,
      };
    }

    return {
      match: null,
      created: false,
    };
  }

  private async ensureConversationForMatch(
    tx: TransactionClient,
    matchId: string,
  ): Promise<void> {
    await tx
      .insert(conversations)
      .values({
        matchId,
      })
      .onConflictDoNothing();
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

  private isMatchTriggerDirection(direction: SwipeDirection): boolean {
    return this.getMatchTriggerDirections().includes(direction);
  }

  private async countTodaySwipeByDirection(
    tx: SelectClient,
    swiperId: string,
    direction: SwipeDirection,
  ): Promise<number> {
    const [countRow] = await tx
      .select({
        count: sql<number>`count(*)`,
      })
      .from(swipes)
      .where(
        and(
          eq(swipes.swiperId, swiperId),
          eq(swipes.isUndone, false),
          gte(swipes.createdAt, this.getUtcDayStart()),
          eq(swipes.direction, direction),
        ),
      );

    return Number(countRow?.count ?? 0);
  }

  private async countTodayRewinds(
    tx: SelectClient,
    swiperId: string,
  ): Promise<number> {
    const [countRow] = await tx
      .select({
        count: sql<number>`count(*)`,
      })
      .from(swipes)
      .where(
        and(
          eq(swipes.swiperId, swiperId),
          eq(swipes.isUndone, true),
          gte(swipes.undoneAt, this.getUtcDayStart()),
        ),
      );

    return Number(countRow?.count ?? 0);
  }

  private async countCurrentMonthBoosts(
    tx: SelectClient,
    userId: string,
  ): Promise<number> {
    const [countRow] = await tx
      .select({
        count: sql<number>`count(*)`,
      })
      .from(userBoosts)
      .where(
        and(
          eq(userBoosts.userId, userId),
          gte(userBoosts.createdAt, this.getUtcMonthStart()),
        ),
      );

    return Number(countRow?.count ?? 0);
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

  private getUtcMonthStart(): Date {
    const now = new Date();

    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
}
