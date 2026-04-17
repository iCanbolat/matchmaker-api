import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ProfileViewsController } from './profile-views.controller';
import { ProfileViewsService } from './profile-views.service';

@Module({
  imports: [SubscriptionsModule, BlocksModule],
  controllers: [ProfileViewsController],
  providers: [ProfileViewsService],
  exports: [ProfileViewsService],
})
export class ProfileViewsModule {}
