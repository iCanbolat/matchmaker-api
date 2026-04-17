import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { GetProfileViewsDto } from './dto/get-profile-views.dto';
import { ProfileViewsService } from './profile-views.service';

@Controller('profile-views')
@UseGuards(JwtAuthGuard)
export class ProfileViewsController {
  constructor(private readonly profileViewsService: ProfileViewsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: GetProfileViewsDto,
  ) {
    return this.profileViewsService.listProfileViews(user.userId, dto.limit);
  }

  @Get('count')
  getCount(@CurrentUser() user: AuthenticatedUser) {
    return this.profileViewsService.getProfileViewsCount(user.userId);
  }
}
