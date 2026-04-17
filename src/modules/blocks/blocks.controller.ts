import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { BlocksService } from './blocks.service';
import { CreateBlockDto } from './dto/create-block.dto';
import { GetBlocksDto } from './dto/get-blocks.dto';

const ONE_MINUTE_IN_MS = 60_000;

@Controller('blocks')
@UseGuards(JwtAuthGuard)
export class BlocksController {
  constructor(private readonly blocksService: BlocksService) {}

  @Post()
  @Throttle({
    default: {
      limit: 20,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: ONE_MINUTE_IN_MS,
    },
  })
  createBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBlockDto,
  ) {
    return this.blocksService.blockUser(user.userId, dto.userId);
  }

  @Delete(':userId')
  @Throttle({
    default: {
      limit: 30,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  removeBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) blockedUserId: string,
  ) {
    return this.blocksService.unblockUser(user.userId, blockedUserId);
  }

  @Get()
  @Throttle({
    default: {
      limit: 90,
      ttl: ONE_MINUTE_IN_MS,
    },
  })
  listMyBlocks(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: GetBlocksDto,
  ) {
    return this.blocksService.listBlockedUsers(user.userId, dto.limit);
  }
}
