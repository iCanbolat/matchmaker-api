import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { NotificationsService } from './notifications.service';

const ONE_MINUTE_IN_MS = 60_000;

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @Throttle({
    default: {
      limit: 120,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ListNotificationsDto,
  ) {
    return this.notificationsService.listNotifications(user.userId, dto);
  }

  @Patch(':id/read')
  @Throttle({
    default: {
      limit: 100,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  markAsRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) notificationId: string,
  ) {
    return this.notificationsService.markAsRead(user.userId, notificationId);
  }

  @Patch('read-all')
  @Throttle({
    default: {
      limit: 20,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  markAllAsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllAsRead(user.userId);
  }

  @Post('device-token')
  @Throttle({
    default: {
      limit: 20,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  registerDeviceToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    return this.notificationsService.registerDeviceToken(user.userId, dto);
  }
}
