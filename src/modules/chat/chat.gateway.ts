import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { type JwtPayload } from '../../common/types/jwt-payload.type';
import { type Env } from '../../config/env.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { ChatService } from './chat.service';
import { type ChatMessageType } from './dto/send-message.dto';

type SocketUser = {
  userId: string;
  email: string;
};

type SendMessagePayload = {
  conversationId: string;
  content: string;
  messageType?: ChatMessageType;
};

type TypingPayload = {
  conversationId: string;
  isTyping: boolean;
};

type ReadReceiptPayload = {
  conversationId: string;
};

type MessageDeliveredPayload = {
  conversationId: string;
  messageId: string;
};

@WebSocketGateway({ namespace: '/chat', cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly notificationsService: NotificationsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractBearerToken(client);
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.configService.get('JWT_ACCESS_SECRET', { infer: true }),
      });

      const user: SocketUser = {
        userId: payload.sub,
        email: payload.email,
      };

      this.setSocketUser(client, user);
      await client.join(user.userId);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(): void {
    // Presence tracking will be added with Redis in notifications phase.
  }

  @SubscribeMessage('send_message')
  async onSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendMessagePayload,
  ) {
    const user = this.requireSocketUser(client);

    const sent = await this.chatService.sendMessage(user.userId, payload);

    for (const participantId of sent.participantIds) {
      this.server.to(participantId).emit('new_message', sent.message);
    }

    await this.notificationsService.notifyMessageReceived({
      recipientUserId: sent.counterpartId,
      senderUserId: user.userId,
      conversationId: sent.message.conversationId,
      messageId: sent.message.id,
      previewText: sent.message.content,
    });

    return {
      event: 'message_sent',
      data: sent.message,
    };
  }

  @SubscribeMessage('typing')
  async onTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TypingPayload,
  ) {
    const user = this.requireSocketUser(client);
    const participantIds = await this.chatService.getConversationParticipantIds(
      user.userId,
      payload.conversationId,
    );

    for (const participantId of participantIds) {
      if (participantId !== user.userId) {
        this.server.to(participantId).emit('typing', {
          conversationId: payload.conversationId,
          userId: user.userId,
          isTyping: payload.isTyping,
        });
      }
    }

    return {
      event: 'typing_ack',
      data: {
        conversationId: payload.conversationId,
      },
    };
  }

  @SubscribeMessage('read_receipt')
  async onReadReceipt(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ReadReceiptPayload,
  ) {
    const user = this.requireSocketUser(client);
    const result = await this.chatService.markConversationAsRead(
      user.userId,
      payload.conversationId,
    );

    for (const participantId of result.participantIds) {
      if (participantId !== user.userId) {
        this.server.to(participantId).emit('read_receipt', {
          conversationId: payload.conversationId,
          readerId: user.userId,
          readCount: result.readCount,
        });
      }
    }

    return {
      event: 'read_receipt_ack',
      data: {
        conversationId: payload.conversationId,
        readCount: result.readCount,
      },
    };
  }

  @SubscribeMessage('message_delivered')
  async onMessageDelivered(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: MessageDeliveredPayload,
  ) {
    const user = this.requireSocketUser(client);
    const participantIds = await this.chatService.getConversationParticipantIds(
      user.userId,
      payload.conversationId,
    );

    for (const participantId of participantIds) {
      if (participantId !== user.userId) {
        this.server.to(participantId).emit('message_delivered', {
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          deliveredBy: user.userId,
        });
      }
    }

    return {
      event: 'message_delivered_ack',
      data: {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
      },
    };
  }

  private extractBearerToken(client: Socket): string {
    const authPayload =
      typeof client.handshake.auth === 'object' &&
      client.handshake.auth !== null
        ? (client.handshake.auth as Record<string, unknown>)
        : undefined;
    const authToken = authPayload?.token;

    if (typeof authToken === 'string' && authToken.trim().length > 0) {
      return authToken.replace(/^Bearer\s+/i, '').trim();
    }

    const header = client.handshake.headers.authorization;

    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim();
    }

    throw new WsException('Unauthorized');
  }

  private setSocketUser(client: Socket, user: SocketUser): void {
    const socketData = client.data as Record<string, unknown>;
    socketData.user = user;
  }

  private requireSocketUser(client: Socket): SocketUser {
    const socketData = client.data as Record<string, unknown>;
    const user = socketData.user;

    if (typeof user !== 'object' || user === null) {
      throw new WsException('Unauthorized');
    }

    const maybeUser = user as Partial<SocketUser>;

    if (
      typeof maybeUser.userId !== 'string' ||
      typeof maybeUser.email !== 'string'
    ) {
      throw new WsException('Unauthorized');
    }

    return {
      userId: maybeUser.userId,
      email: maybeUser.email,
    };
  }
}
