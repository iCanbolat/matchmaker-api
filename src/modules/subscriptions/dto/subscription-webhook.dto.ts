import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PAID_SUBSCRIPTION_TIERS,
  SUBSCRIPTION_PLATFORMS,
  type PaidSubscriptionTier,
  type SubscriptionPlatform,
} from '../subscriptions.types';

export class SubscriptionWebhookDto {
  @IsUUID('4')
  userId!: string;

  @IsIn(SUBSCRIPTION_PLATFORMS)
  platform!: SubscriptionPlatform;

  @IsIn(PAID_SUBSCRIPTION_TIERS)
  tier!: PaidSubscriptionTier;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  storeTransactionId!: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  expiresAt!: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isCancelled?: boolean;
}
