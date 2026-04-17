import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { GetDiscoveryCardsDto } from './dto/get-discovery-cards.dto';
import { SwipeDto } from './dto/swipe.dto';
import { DiscoveryService } from './discovery.service';

const ONE_MINUTE_IN_MS = 60_000;

@Controller('discovery')
@UseGuards(JwtAuthGuard)
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('cards')
  @Throttle({
    default: {
      limit: 90,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  getCards(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: GetDiscoveryCardsDto,
  ) {
    return this.discoveryService.getCards(user.userId, dto.limit);
  }

  @Get('swipe-limit')
  @Throttle({
    default: {
      limit: 90,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  getSwipeLimitStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.discoveryService.getSwipeLimitStatus(user.userId);
  }

  @Post('swipe')
  @Throttle({
    default: {
      limit: 80,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: 15_000,
    },
  })
  swipe(@CurrentUser() user: AuthenticatedUser, @Body() dto: SwipeDto) {
    return this.discoveryService.swipe(user.userId, dto);
  }

  @Post('rewind')
  @Throttle({
    default: {
      limit: 20,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: ONE_MINUTE_IN_MS,
    },
  })
  rewind(@CurrentUser() user: AuthenticatedUser) {
    return this.discoveryService.rewind(user.userId);
  }

  @Post('boost')
  @Throttle({
    default: {
      limit: 8,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: ONE_MINUTE_IN_MS,
    },
  })
  boost(@CurrentUser() user: AuthenticatedUser) {
    return this.discoveryService.boost(user.userId);
  }
}
