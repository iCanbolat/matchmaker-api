import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { SwipeDto } from './dto/swipe.dto';
import { DiscoveryService } from './discovery.service';

@Controller('discovery')
@UseGuards(JwtAuthGuard)
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('swipe-limit')
  getSwipeLimitStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.discoveryService.getSwipeLimitStatus(user.userId);
  }

  @Post('swipe')
  swipe(@CurrentUser() user: AuthenticatedUser, @Body() dto: SwipeDto) {
    return this.discoveryService.swipe(user.userId, dto);
  }
}
