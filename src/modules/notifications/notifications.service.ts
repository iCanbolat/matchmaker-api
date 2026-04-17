import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  notificationDeviceTokens,
  notifications,
  users,
} from '../../database/schema';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsQueueService } from './notifications-queue.service';
import { type NotificationType } from './notifications.types';

const DEFAULT_NOTIFICATIONS_LIMIT = 20;
const MAX_NOTIFICATIONS_LIMIT = 100;

type CreateNotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
};

@Injectable()
export class NotificationsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly notificationsQueueService: NotificationsQueueService,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async listNotifications(userId: string, dto: ListNotificationsDto) {
    await this.ensureUserExists(userId);

    const limit = this.resolveLimit(dto.limit);
    const beforeDate = dto.before ? new Date(dto.before) : null;
    const unreadOnly = dto.unreadOnly === 'true';

    const rows = await this.db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        data: notifications.data,
        isRead: notifications.isRead,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          beforeDate ? lt(notifications.createdAt, beforeDate) : undefined,
          unreadOnly ? eq(notifications.isRead, false) : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    const oldestNotification = rows.at(rows.length - 1) ?? null;

    return {
      count: rows.length,
      notifications: rows,
      nextCursor: oldestNotification?.createdAt.toISOString() ?? null,
    };
  }

  async markAsRead(userId: string, notificationId: string) {
    const [updated] = await this.db
      .update(notifications)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
        ),
      )
      .returning({
        id: notifications.id,
        isRead: notifications.isRead,
        readAt: notifications.readAt,
      });

    if (!updated) {
      throw new NotFoundException('Notification not found.');
    }

    return updated;
  }

  async markAllAsRead(userId: string) {
    const rows = await this.db
      .update(notifications)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(
        and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
      )
      .returning({
        id: notifications.id,
      });

    return {
      updatedCount: rows.length,
    };
  }

  async registerDeviceToken(userId: string, dto: RegisterDeviceTokenDto) {
    await this.ensureUserExists(userId);

    const now = new Date();

    const [saved] = await this.db
      .insert(notificationDeviceTokens)
      .values({
        userId,
        platform: dto.platform,
        deviceToken: dto.token.trim(),
        isActive: true,
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: notificationDeviceTokens.deviceToken,
        set: {
          userId,
          platform: dto.platform,
          isActive: true,
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .returning({
        id: notificationDeviceTokens.id,
        platform: notificationDeviceTokens.platform,
        token: notificationDeviceTokens.deviceToken,
        updatedAt: notificationDeviceTokens.updatedAt,
      });

    return {
      ...saved,
      registered: true,
    };
  }

  async notifyMatchCreated(matchId: string, user1Id: string, user2Id: string) {
    const participants = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
      })
      .from(users)
      .where(
        and(
          inArray(users.id, [user1Id, user2Id]),
          isNull(users.deletedAt),
          eq(users.isActive, true),
        ),
      );

    const participantById = new Map(
      participants.map((participant) => [participant.id, participant]),
    );
    const user1 = participantById.get(user1Id);
    const user2 = participantById.get(user2Id);

    if (!user1 || !user2) {
      return;
    }

    await Promise.all([
      this.createAndDispatch({
        userId: user1Id,
        type: 'match',
        title: `${user2.firstName} ile eşleştiniz`,
        body: 'Yeni eşleşmeniz için sohbete başlayabilirsiniz.',
        data: {
          matchId,
          counterpartUserId: user2Id,
        },
      }),
      this.createAndDispatch({
        userId: user2Id,
        type: 'match',
        title: `${user1.firstName} ile eşleştiniz`,
        body: 'Yeni eşleşmeniz için sohbete başlayabilirsiniz.',
        data: {
          matchId,
          counterpartUserId: user1Id,
        },
      }),
    ]);
  }

  async notifyMessageReceived(input: {
    recipientUserId: string;
    senderUserId: string;
    conversationId: string;
    messageId: string;
    previewText: string;
  }) {
    if (input.recipientUserId === input.senderUserId) {
      return;
    }

    const [sender] = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
      })
      .from(users)
      .where(
        and(
          eq(users.id, input.senderUserId),
          isNull(users.deletedAt),
          eq(users.isActive, true),
        ),
      )
      .limit(1);

    if (!sender) {
      return;
    }

    const preview = input.previewText.trim();
    const body = preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;

    await this.createAndDispatch({
      userId: input.recipientUserId,
      type: 'message',
      title: `${sender.firstName} yeni bir mesaj gönderdi`,
      body,
      data: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        senderUserId: input.senderUserId,
      },
    });
  }

  private async createAndDispatch(input: CreateNotificationInput) {
    const [created] = await this.db
      .insert(notifications)
      .values({
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        data: input.data ?? null,
        isRead: false,
      })
      .returning({
        id: notifications.id,
        userId: notifications.userId,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        data: notifications.data,
        isRead: notifications.isRead,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      });

    this.notificationsGateway.emitToUser(created.userId, 'new_notification', {
      id: created.id,
      type: created.type,
      title: created.title,
      body: created.body,
      data: created.data,
      isRead: created.isRead,
      readAt: created.readAt,
      createdAt: created.createdAt,
    });

    const userOnline = this.notificationsGateway.isUserOnline(created.userId);

    if (!userOnline) {
      await this.notificationsQueueService.enqueuePush({
        notificationId: created.id,
        userId: created.userId,
        type: created.type as NotificationType,
        title: created.title,
        body: created.body,
        data: created.data,
      });
    }

    return created;
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          isNull(users.deletedAt),
          eq(users.isActive, true),
        ),
      )
      .limit(1);

    if (!user) {
      throw new NotFoundException('User not found.');
    }
  }

  private resolveLimit(requestedLimit?: number): number {
    if (!requestedLimit) {
      return DEFAULT_NOTIFICATIONS_LIMIT;
    }

    return Math.min(Math.max(requestedLimit, 1), MAX_NOTIFICATIONS_LIMIT);
  }
}
