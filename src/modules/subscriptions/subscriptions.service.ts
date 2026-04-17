import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { type Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.service';
import { subscriptions, users } from '../../database/schema';
import { SubscriptionPolicyService } from './subscription-policy.service';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { PurchaseSubscriptionDto } from './dto/purchase-subscription.dto';
import { SubscriptionWebhookDto } from './dto/subscription-webhook.dto';
import { VerifyReceiptDto } from './dto/verify-receipt.dto';
import { ReceiptValidatorService } from './receipt-validator.service';
import {
  SUBSCRIPTION_PLANS,
  type PaidSubscriptionTier,
  type SubscriptionTier,
} from './subscriptions.types';

type TransactionClient = {
  select: DatabaseService['db']['select'];
  insert: DatabaseService['db']['insert'];
  update: DatabaseService['db']['update'];
};

type SelectClient = {
  select: DatabaseService['db']['select'];
};

type ActiveSubscriptionRecord = {
  id: string;
  tier: PaidSubscriptionTier;
  platform: string;
  storeTransactionId: string | null;
  startsAt: Date;
  expiresAt: Date;
  isCancelled: boolean;
  cancelledAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<Env, true>,
    private readonly subscriptionPolicyService: SubscriptionPolicyService,
    private readonly receiptValidatorService: ReceiptValidatorService,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async getPlans(userId: string) {
    const user = await this.ensureUserExists(userId);
    const effectiveTier = this.subscriptionPolicyService.resolveEffectiveTier(
      user.subscriptionTier,
      user.subscriptionExpiresAt,
    );

    return {
      currentTier: effectiveTier,
      currentSubscriptionExpiresAt: user.subscriptionExpiresAt,
      plans: SUBSCRIPTION_PLANS,
    };
  }

  async purchase(userId: string, dto: PurchaseSubscriptionDto) {
    await this.ensureUserExists(userId);

    return {
      status: 'requires_client_purchase',
      platform: dto.platform,
      tier: dto.tier,
      billingCycle: dto.billingCycle ?? 'monthly',
      productId: dto.productId ?? null,
      verificationEndpoint: '/subscriptions/verify-receipt',
    };
  }

  async verifyReceipt(userId: string, dto: VerifyReceiptDto) {
    await this.ensureUserExists(userId);

    const validatedReceipt =
      await this.receiptValidatorService.validateReceipt(dto);

    if (validatedReceipt.expiresAt <= new Date()) {
      throw new BadRequestException(
        'Receipt is valid but subscription already expired.',
      );
    }

    const result = await this.db.transaction(async (tx) => {
      const now = new Date();

      const [savedSubscription] = await tx
        .insert(subscriptions)
        .values({
          userId,
          tier: dto.tier,
          platform: dto.platform,
          storeTransactionId: validatedReceipt.storeTransactionId,
          startsAt: validatedReceipt.startsAt,
          expiresAt: validatedReceipt.expiresAt,
          isCancelled: validatedReceipt.isCancelled,
          cancelledAt: validatedReceipt.isCancelled ? now : null,
        })
        .onConflictDoUpdate({
          target: subscriptions.storeTransactionId,
          set: {
            userId,
            tier: dto.tier,
            platform: dto.platform,
            startsAt: validatedReceipt.startsAt,
            expiresAt: validatedReceipt.expiresAt,
            isCancelled: validatedReceipt.isCancelled,
            cancelledAt: validatedReceipt.isCancelled ? now : null,
          },
        })
        .returning({
          id: subscriptions.id,
          tier: subscriptions.tier,
          platform: subscriptions.platform,
          storeTransactionId: subscriptions.storeTransactionId,
          startsAt: subscriptions.startsAt,
          expiresAt: subscriptions.expiresAt,
          isCancelled: subscriptions.isCancelled,
          cancelledAt: subscriptions.cancelledAt,
          createdAt: subscriptions.createdAt,
        });

      const syncedState = await this.syncUserSubscriptionState(userId, tx);

      return {
        savedSubscription,
        syncedState,
      };
    });

    return {
      verified: true,
      subscription: result.savedSubscription,
      currentTier: result.syncedState.tier,
      currentSubscriptionExpiresAt: result.syncedState.expiresAt,
    };
  }

  async getMySubscription(userId: string) {
    const user = await this.ensureUserExists(userId);
    const activeSubscription = await this.getBestActiveSubscription(userId);
    const effectiveTier = this.subscriptionPolicyService.resolveEffectiveTier(
      user.subscriptionTier,
      user.subscriptionExpiresAt,
    );

    const history = await this.db
      .select({
        id: subscriptions.id,
        tier: subscriptions.tier,
        platform: subscriptions.platform,
        storeTransactionId: subscriptions.storeTransactionId,
        startsAt: subscriptions.startsAt,
        expiresAt: subscriptions.expiresAt,
        isCancelled: subscriptions.isCancelled,
        cancelledAt: subscriptions.cancelledAt,
        createdAt: subscriptions.createdAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(20);

    return {
      tier: effectiveTier,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      activeSubscription,
      history,
    };
  }

  async cancelSubscription(userId: string, dto: CancelSubscriptionDto) {
    await this.ensureUserExists(userId);

    const now = new Date();
    const activeRows = await this.db
      .select({
        id: subscriptions.id,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.isCancelled, false),
          gt(subscriptions.expiresAt, now),
        ),
      );

    if (activeRows.length === 0) {
      throw new NotFoundException('Active subscription not found.');
    }

    const updatedRows = await this.db
      .update(subscriptions)
      .set({
        isCancelled: true,
        cancelledAt: now,
      })
      .where(
        inArray(
          subscriptions.id,
          activeRows.map((row) => row.id),
        ),
      )
      .returning({ id: subscriptions.id });

    const syncedState = await this.syncUserSubscriptionState(userId);

    return {
      cancelledCount: updatedRows.length,
      reason: dto.reason ?? null,
      currentTier: syncedState.tier,
      currentSubscriptionExpiresAt: syncedState.expiresAt,
    };
  }

  async handleAppleWebhook(
    webhookSecret: string | undefined,
    dto: SubscriptionWebhookDto,
  ) {
    this.assertWebhookSecret(webhookSecret);

    return this.applyWebhookUpdate('apple', dto);
  }

  async handleGoogleWebhook(
    webhookSecret: string | undefined,
    dto: SubscriptionWebhookDto,
  ) {
    this.assertWebhookSecret(webhookSecret);

    return this.applyWebhookUpdate('google', dto);
  }

  private async applyWebhookUpdate(
    source: 'apple' | 'google',
    dto: SubscriptionWebhookDto,
  ) {
    const startsAt = new Date(dto.startsAt);
    const expiresAt = new Date(dto.expiresAt);

    if (
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(expiresAt.getTime())
    ) {
      throw new BadRequestException('Invalid startsAt or expiresAt value.');
    }

    if (expiresAt <= startsAt) {
      throw new BadRequestException('expiresAt must be later than startsAt.');
    }

    await this.ensureUserExists(dto.userId);

    const result = await this.db.transaction(async (tx) => {
      const now = new Date();

      const [savedSubscription] = await tx
        .insert(subscriptions)
        .values({
          userId: dto.userId,
          tier: dto.tier,
          platform: dto.platform,
          storeTransactionId: dto.storeTransactionId,
          startsAt,
          expiresAt,
          isCancelled: dto.isCancelled ?? false,
          cancelledAt: dto.isCancelled ? now : null,
        })
        .onConflictDoUpdate({
          target: subscriptions.storeTransactionId,
          set: {
            userId: dto.userId,
            tier: dto.tier,
            platform: dto.platform,
            startsAt,
            expiresAt,
            isCancelled: dto.isCancelled ?? false,
            cancelledAt: dto.isCancelled ? now : null,
          },
        })
        .returning({
          id: subscriptions.id,
          tier: subscriptions.tier,
          platform: subscriptions.platform,
          storeTransactionId: subscriptions.storeTransactionId,
          startsAt: subscriptions.startsAt,
          expiresAt: subscriptions.expiresAt,
          isCancelled: subscriptions.isCancelled,
          cancelledAt: subscriptions.cancelledAt,
          createdAt: subscriptions.createdAt,
        });

      const syncedState = await this.syncUserSubscriptionState(dto.userId, tx);

      return {
        savedSubscription,
        syncedState,
      };
    });

    return {
      acknowledged: true,
      source,
      subscription: result.savedSubscription,
      currentTier: result.syncedState.tier,
      currentSubscriptionExpiresAt: result.syncedState.expiresAt,
    };
  }

  private assertWebhookSecret(providedSecret: string | undefined): void {
    const expectedSecret = this.configService.get(
      'SUBSCRIPTIONS_WEBHOOK_SECRET',
      {
        infer: true,
      },
    );

    if (!expectedSecret) {
      return;
    }

    if (!providedSecret || providedSecret !== expectedSecret) {
      throw new UnauthorizedException('Invalid webhook secret.');
    }
  }

  private async syncUserSubscriptionState(
    userId: string,
    tx: Pick<TransactionClient, 'select' | 'update'> = this.db,
  ): Promise<{ tier: SubscriptionTier; expiresAt: Date | null }> {
    const activeSubscription = await this.getBestActiveSubscription(userId, tx);

    const nextTier: SubscriptionTier = activeSubscription
      ? activeSubscription.tier
      : 'free';
    const nextExpiresAt = activeSubscription?.expiresAt ?? null;

    await tx
      .update(users)
      .set({
        subscriptionTier: nextTier,
        subscriptionExpiresAt: nextExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return {
      tier: nextTier,
      expiresAt: nextExpiresAt,
    };
  }

  private async getBestActiveSubscription(
    userId: string,
    tx: SelectClient = this.db,
  ): Promise<ActiveSubscriptionRecord | null> {
    const now = new Date();

    const rows = await tx
      .select({
        id: subscriptions.id,
        tier: subscriptions.tier,
        platform: subscriptions.platform,
        storeTransactionId: subscriptions.storeTransactionId,
        startsAt: subscriptions.startsAt,
        expiresAt: subscriptions.expiresAt,
        isCancelled: subscriptions.isCancelled,
        cancelledAt: subscriptions.cancelledAt,
        createdAt: subscriptions.createdAt,
      })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.userId, userId), gt(subscriptions.expiresAt, now)),
      )
      .orderBy(desc(subscriptions.expiresAt), desc(subscriptions.createdAt));

    let selected: ActiveSubscriptionRecord | null = null;

    for (const row of rows) {
      const normalizedTier = this.toPaidTier(row.tier);

      if (!normalizedTier) {
        continue;
      }

      const candidate: ActiveSubscriptionRecord = {
        ...row,
        tier: normalizedTier,
      };

      if (!selected) {
        selected = candidate;
        continue;
      }

      const candidatePriority = this.subscriptionPolicyService.getTierPriority(
        candidate.tier,
      );
      const selectedPriority = this.subscriptionPolicyService.getTierPriority(
        selected.tier,
      );

      if (
        candidatePriority > selectedPriority ||
        (candidatePriority === selectedPriority &&
          candidate.expiresAt > selected.expiresAt)
      ) {
        selected = candidate;
      }
    }

    return selected;
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
          isNull(users.deletedAt),
          eq(users.isActive, true),
        ),
      )
      .limit(1);

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return user;
  }

  private toPaidTier(value: string): PaidSubscriptionTier | null {
    if (value === 'plus' || value === 'premium') {
      return value;
    }

    return null;
  }
}
