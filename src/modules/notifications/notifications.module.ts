import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsController } from './notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsQueueService } from './notifications-queue.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

@Module({
  imports: [JwtModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsGateway,
    NotificationsQueueService,
    NotificationsService,
    PushService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
