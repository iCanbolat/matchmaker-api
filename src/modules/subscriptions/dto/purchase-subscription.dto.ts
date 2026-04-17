import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PAID_SUBSCRIPTION_TIERS,
  SUBSCRIPTION_PLATFORMS,
  type PaidSubscriptionTier,
  type SubscriptionPlatform,
} from '../subscriptions.types';

export const BILLING_CYCLES = ['monthly', 'yearly'] as const;

export type BillingCycle = (typeof BILLING_CYCLES)[number];

export class PurchaseSubscriptionDto {
  @IsIn(SUBSCRIPTION_PLATFORMS)
  platform!: SubscriptionPlatform;

  @IsIn(PAID_SUBSCRIPTION_TIERS)
  tier!: PaidSubscriptionTier;

  @IsOptional()
  @IsIn(BILLING_CYCLES)
  billingCycle?: BillingCycle;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  productId?: string;
}
