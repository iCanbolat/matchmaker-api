import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { swipes, users } from '../../database/schema';
import { ReferralBonusService } from '../referrals/referral-bonus.service';
import {
  type SwipeDirection,
  type SwipeDto,
  SWIPE_DIRECTIONS,
} from './dto/swipe.dto';

type SubscriptionTier = 'free' | 'plus' | 'premium';

type DailySwipeLimit = number | null;

const DAILY_SWIPE_LIMITS: Record<SubscriptionTier, DailySwipeLimit> = {
  free: 20,
  plus: 100,
  premium: null,
};

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly referralBonusService: ReferralBonusService,
  ) {}

  private get db() {
    return this.databaseService.db;
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

      const remainingSwipeCredits =
        await this.referralBonusService.getRemainingSwipeCredits(tx, swiperId);

      return {
        swipe,
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

  private isCountedDirection(
    direction: SwipeDirection,
  ): direction is (typeof SWIPE_DIRECTIONS)[number] {
    return this.getCountedDirections().includes(direction);
  }

  private getCountedDirections(): Array<(typeof SWIPE_DIRECTIONS)[number]> {
    return ['like', 'super_like'];
  }

  private getUtcDayStart(): Date {
    const now = new Date();

    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
}
