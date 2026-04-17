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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { ChatService } from './chat.service';
import { GetMessagesDto } from './dto/get-messages.dto';
import { SendMessageBodyDto } from './dto/send-message.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('conversations')
  listConversations(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;

    return this.chatService.listConversations(user.userId, parsedLimit);
  }

  @Get('conversations/:id/messages')
  getMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Query() dto: GetMessagesDto,
  ) {
    return this.chatService.getMessages(
      user.userId,
      conversationId,
      dto.limit,
      dto.before,
    );
  }

  @Post('conversations/:id/messages')
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Body() dto: SendMessageBodyDto,
  ) {
    return this.chatService.sendMessage(user.userId, {
      ...dto,
      conversationId,
    });
  }

  @Patch('conversations/:id/read')
  markConversationAsRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) conversationId: string,
  ) {
    return this.chatService.markConversationAsRead(user.userId, conversationId);
  }
}
