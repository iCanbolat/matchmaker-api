import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { type Env } from '../../config/env.schema';
import { type DatabaseService } from '../../database/database.service';
import { referrals, userReferralCredits, users } from '../../database/schema';

type TransactionClient = {
  select: DatabaseService['db']['select'];
  insert: DatabaseService['db']['insert'];
  update: DatabaseService['db']['update'];
};

type CompleteReferralParams = {
  referrerId: string;
  referredId: string;
  referralCodeUsed: string;
};

type ReferralBonusType = Env['REFERRAL_BONUS_TYPE'];

export type ReferralBonusResult = {
  bonusType: ReferralBonusType;
  bonusValue: number;
};

@Injectable()
export class ReferralBonusService {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  async consumeSwipeCredit(
    tx: TransactionClient,
    userId: string,
  ): Promise<boolean> {
    const [updatedCredit] = await tx
      .update(userReferralCredits)
      .set({
        swipeCredits: sql`${userReferralCredits.swipeCredits} - 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userReferralCredits.userId, userId),
          gt(userReferralCredits.swipeCredits, 0),
        ),
      )
      .returning({
        userId: userReferralCredits.userId,
      });

    return Boolean(updatedCredit);
  }

  async getRemainingSwipeCredits(
    tx: Pick<TransactionClient, 'select'>,
    userId: string,
  ): Promise<number> {
    const [creditRow] = await tx
      .select({
        swipeCredits: userReferralCredits.swipeCredits,
      })
      .from(userReferralCredits)
      .where(eq(userReferralCredits.userId, userId))
      .limit(1);

    return creditRow?.swipeCredits ?? 0;
  }

  async completeReferral(
    tx: TransactionClient,
    params: CompleteReferralParams,
  ): Promise<ReferralBonusResult> {
    const bonusType = this.configService.get('REFERRAL_BONUS_TYPE', {
      infer: true,
    });
    const bonusValue = await this.applyBonus(tx, bonusType, params.referrerId);

    await tx.insert(referrals).values({
      referrerId: params.referrerId,
      referredId: params.referredId,
      referralCodeUsed: params.referralCodeUsed,
      status: 'completed',
      bonusType,
      bonusValue,
    });

    return {
      bonusType,
      bonusValue,
    };
  }

  private async applyBonus(
    tx: TransactionClient,
    bonusType: ReferralBonusType,
    referrerId: string,
  ): Promise<number> {
    if (bonusType === 'none') {
      return 0;
    }

    if (bonusType === 'swipe_credit') {
      return this.applySwipeCreditBonus(tx, referrerId);
    }

    return this.applyPlusDaysBonus(tx, referrerId);
  }

  private async applyPlusDaysBonus(
    tx: TransactionClient,
    referrerId: string,
  ): Promise<number> {
    const plusDays = this.configService.get('REFERRAL_BONUS_PLUS_DAYS', {
      infer: true,
    });

    const [referrer] = await tx
      .select({
        id: users.id,
        subscriptionTier: users.subscriptionTier,
        subscriptionExpiresAt: users.subscriptionExpiresAt,
      })
      .from(users)
      .where(and(eq(users.id, referrerId), isNull(users.deletedAt)))
      .limit(1);

    if (!referrer) {
      throw new NotFoundException('Referrer user not found.');
    }

    const now = new Date();
    const baseDate =
      referrer.subscriptionExpiresAt && referrer.subscriptionExpiresAt > now
        ? referrer.subscriptionExpiresAt
        : now;
    const nextExpiry = new Date(baseDate);
    nextExpiry.setDate(nextExpiry.getDate() + plusDays);

    await tx
      .update(users)
      .set({
        subscriptionTier:
          referrer.subscriptionTier === 'premium' ? 'premium' : 'plus',
        subscriptionExpiresAt: nextExpiry,
        updatedAt: now,
      })
      .where(eq(users.id, referrerId));

    return plusDays;
  }

  private async applySwipeCreditBonus(
    tx: TransactionClient,
    referrerId: string,
  ): Promise<number> {
    const swipeCredits = this.configService.get(
      'REFERRAL_BONUS_SWIPE_CREDITS',
      {
        infer: true,
      },
    );

    const [referrer] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, referrerId), isNull(users.deletedAt)))
      .limit(1);

    if (!referrer) {
      throw new NotFoundException('Referrer user not found.');
    }

    await tx
      .insert(userReferralCredits)
      .values({
        userId: referrerId,
        swipeCredits,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userReferralCredits.userId,
        set: {
          swipeCredits: sql`${userReferralCredits.swipeCredits} + ${swipeCredits}`,
          updatedAt: new Date(),
        },
      });

    return swipeCredits;
  }
}
