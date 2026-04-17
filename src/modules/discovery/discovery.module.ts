import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProfileViewsModule } from '../profile-views/profile-views.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

@Module({
  imports: [
    BlocksModule,
    ReferralsModule,
    NotificationsModule,
    ProfileViewsModule,
    SubscriptionsModule,
  ],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
})
export class DiscoveryModule {}
