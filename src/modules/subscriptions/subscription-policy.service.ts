import { Injectable } from '@nestjs/common';
import {
  SUBSCRIPTION_LIMITS,
  type SubscriptionLimits,
  type SubscriptionTier,
} from './subscriptions.types';

@Injectable()
export class SubscriptionPolicyService {
  resolveEffectiveTier(
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

  getLimitsForTier(tier: SubscriptionTier): SubscriptionLimits {
    return {
      ...SUBSCRIPTION_LIMITS[tier],
    };
  }

  getTierPriority(tier: SubscriptionTier): number {
    if (tier === 'premium') {
      return 2;
    }

    if (tier === 'plus') {
      return 1;
    }

    return 0;
  }
}
