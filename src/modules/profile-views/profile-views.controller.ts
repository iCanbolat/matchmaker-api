import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { GetProfileViewsDto } from './dto/get-profile-views.dto';
import { ProfileViewsService } from './profile-views.service';

const ONE_MINUTE_IN_MS = 60_000;

@Controller('profile-views')
@UseGuards(JwtAuthGuard)
export class ProfileViewsController {
  constructor(private readonly profileViewsService: ProfileViewsService) {}

  @Get()
  @Throttle({
    default: {
      limit: 40,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: GetProfileViewsDto,
  ) {
    return this.profileViewsService.listProfileViews(user.userId, dto.limit);
  }

  @Get('count')
  @Throttle({
    default: {
      limit: 80,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  getCount(@CurrentUser() user: AuthenticatedUser) {
    return this.profileViewsService.getProfileViewsCount(user.userId);
  }
}
