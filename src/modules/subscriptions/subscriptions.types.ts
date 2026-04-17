export const SUBSCRIPTION_TIERS = ['free', 'plus', 'premium'] as const;

export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const PAID_SUBSCRIPTION_TIERS = ['plus', 'premium'] as const;

export type PaidSubscriptionTier = (typeof PAID_SUBSCRIPTION_TIERS)[number];

export const SUBSCRIPTION_PLATFORMS = ['ios', 'android', 'web'] as const;

export type SubscriptionPlatform = (typeof SUBSCRIPTION_PLATFORMS)[number];

export type DailyActionLimit = number | null;

export type SubscriptionLimits = {
  dailyLikeLimit: DailyActionLimit;
  dailySuperLikeLimit: DailyActionLimit;
  dailyRewindLimit: DailyActionLimit;
  monthlyBoostLimit: number;
};

export const SUBSCRIPTION_LIMITS: Record<SubscriptionTier, SubscriptionLimits> =
  {
    free: {
      dailyLikeLimit: 20,
      dailySuperLikeLimit: 1,
      dailyRewindLimit: 0,
      monthlyBoostLimit: 0,
    },
    plus: {
      dailyLikeLimit: 100,
      dailySuperLikeLimit: 5,
      dailyRewindLimit: 3,
      monthlyBoostLimit: 1,
    },
    premium: {
      dailyLikeLimit: null,
      dailySuperLikeLimit: 10,
      dailyRewindLimit: null,
      monthlyBoostLimit: 3,
    },
  };

export type SubscriptionPlan = {
  tier: PaidSubscriptionTier;
  title: string;
  description: string;
  currency: 'TRY';
  monthlyPrice: number;
  yearlyPrice: number;
  features: string[];
  limits: SubscriptionLimits;
};

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    tier: 'plus',
    title: 'Matchmaker Plus',
    description:
      'Daha fazla swipe, daha fazla super like ve gelişmiş filtreler.',
    currency: 'TRY',
    monthlyPrice: 299,
    yearlyPrice: 2499,
    features: [
      'Gunluk 100 like',
      'Gunluk 5 super like',
      'Gunluk 3 rewind',
      'Aylik 1 boost',
      'Gelismis filtreler',
      'Reklamsiz deneyim',
    ],
    limits: SUBSCRIPTION_LIMITS.plus,
  },
  {
    tier: 'premium',
    title: 'Matchmaker Premium',
    description: 'Maksimum gorunurluk ve premium ozelliklerin tumu.',
    currency: 'TRY',
    monthlyPrice: 449,
    yearlyPrice: 3699,
    features: [
      'Sinirsiz like',
      'Gunluk 10 super like',
      'Sinirsiz rewind',
      'Aylik 3 boost',
      'Profil goruntuleyenleri gorme',
      'Oncelikli gorunurluk',
    ],
    limits: SUBSCRIPTION_LIMITS.premium,
  },
];

export type ValidatedSubscriptionReceipt = {
  storeTransactionId: string;
  startsAt: Date;
  expiresAt: Date;
  isCancelled: boolean;
  raw: Record<string, unknown> | null;
};
