import { Module } from '@nestjs/common';
import { ReferralBonusService } from './referral-bonus.service';

@Module({
  providers: [ReferralBonusService],
  exports: [ReferralBonusService],
})
export class ReferralsModule {}
