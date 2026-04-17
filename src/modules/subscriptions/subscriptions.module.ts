import { Module } from '@nestjs/common';
import { ReceiptValidatorService } from './receipt-validator.service';
import { SubscriptionPolicyService } from './subscription-policy.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  controllers: [SubscriptionsController],
  providers: [
    ReceiptValidatorService,
    SubscriptionPolicyService,
    SubscriptionsService,
  ],
  exports: [SubscriptionPolicyService, SubscriptionsService],
})
export class SubscriptionsModule {}
