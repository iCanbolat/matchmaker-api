import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
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

export class VerifyReceiptDto {
  @IsIn(SUBSCRIPTION_PLATFORMS)
  platform!: SubscriptionPlatform;

  @IsIn(PAID_SUBSCRIPTION_TIERS)
  tier!: PaidSubscriptionTier;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(20000)
  receiptData?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  purchaseToken?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  subscriptionId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  storeTransactionId?: string;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isSandbox?: boolean;
}
