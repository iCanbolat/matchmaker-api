import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { type JwtPayload } from '../../common/types/jwt-payload.type';
import { type Env } from '../../config/env.schema';

type SocketUser = {
  userId: string;
  email: string;
};

@WebSocketGateway({ namespace: '/notifications', cors: { origin: '*' } })
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server!: Server;

  private readonly onlineConnectionCounts = new Map<string, number>();

  constructor(
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
      this.trackConnected(user.userId);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const user = this.getSocketUser(client);

    if (!user) {
      return;
    }

    this.trackDisconnected(user.userId);
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server.to(userId).emit(event, payload);
  }

  isUserOnline(userId: string): boolean {
    return (this.onlineConnectionCounts.get(userId) ?? 0) > 0;
  }

  private trackConnected(userId: string): void {
    const current = this.onlineConnectionCounts.get(userId) ?? 0;
    this.onlineConnectionCounts.set(userId, current + 1);
  }

  private trackDisconnected(userId: string): void {
    const current = this.onlineConnectionCounts.get(userId) ?? 0;

    if (current <= 1) {
      this.onlineConnectionCounts.delete(userId);
      return;
    }

    this.onlineConnectionCounts.set(userId, current - 1);
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

  private getSocketUser(client: Socket): SocketUser | null {
    const socketData = client.data as Record<string, unknown>;
    const user = socketData.user;

    if (typeof user !== 'object' || user === null) {
      return null;
    }

    const maybeUser = user as Partial<SocketUser>;

    if (
      typeof maybeUser.userId !== 'string' ||
      typeof maybeUser.email !== 'string'
    ) {
      return null;
    }

    return {
      userId: maybeUser.userId,
      email: maybeUser.email,
    };
  }
}
