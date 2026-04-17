import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { GetDiscoveryCardsDto } from './dto/get-discovery-cards.dto';
import { SwipeDto } from './dto/swipe.dto';
import { DiscoveryService } from './discovery.service';

@Controller('discovery')
@UseGuards(JwtAuthGuard)
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('cards')
  getCards(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: GetDiscoveryCardsDto,
  ) {
    return this.discoveryService.getCards(user.userId, dto.limit);
  }

  @Get('swipe-limit')
  getSwipeLimitStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.discoveryService.getSwipeLimitStatus(user.userId);
  }

  @Post('swipe')
  swipe(@CurrentUser() user: AuthenticatedUser, @Body() dto: SwipeDto) {
    return this.discoveryService.swipe(user.userId, dto);
  }

  @Post('rewind')
  rewind(@CurrentUser() user: AuthenticatedUser) {
    return this.discoveryService.rewind(user.userId);
  }

  @Post('boost')
  boost(@CurrentUser() user: AuthenticatedUser) {
    return this.discoveryService.boost(user.userId);
  }
}
