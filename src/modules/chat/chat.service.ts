import { Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  conversations,
  matches,
  messages,
  userPhotos,
  users,
} from '../../database/schema';
import {
  CHAT_MESSAGE_TYPES,
  type ChatMessageType,
  type SendMessageDto,
} from './dto/send-message.dto';

const DEFAULT_CONVERSATIONS_LIMIT = 20;
const MAX_CONVERSATIONS_LIMIT = 100;
const DEFAULT_MESSAGES_LIMIT = 30;
const MAX_MESSAGES_LIMIT = 100;

type ConversationMembership = {
  conversationId: string;
  matchId: string;
  user1Id: string;
  user2Id: string;
};

@Injectable()
export class ChatService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get db() {
    return this.databaseService.db;
  }

  async listConversations(userId: string, requestedLimit?: number) {
    const limit = this.resolveLimit(
      requestedLimit,
      DEFAULT_CONVERSATIONS_LIMIT,
      MAX_CONVERSATIONS_LIMIT,
    );

    await this.ensureUserExists(userId);

    const conversationRows = await this.db
      .select({
        id: conversations.id,
        matchId: conversations.matchId,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
        user1Id: matches.user1Id,
        user2Id: matches.user2Id,
      })
      .from(conversations)
      .innerJoin(matches, eq(conversations.matchId, matches.id))
      .where(
        and(
          eq(matches.isActive, true),
          or(eq(matches.user1Id, userId), eq(matches.user2Id, userId)),
        ),
      )
      .orderBy(
        desc(
          sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`,
        ),
      )
      .limit(limit);

    if (conversationRows.length === 0) {
      return {
        count: 0,
        conversations: [],
      };
    }

    const counterpartIds = Array.from(
      new Set(
        conversationRows.map((conversation) =>
          conversation.user1Id === userId
            ? conversation.user2Id
            : conversation.user1Id,
        ),
      ),
    );
    const conversationIds = conversationRows.map(
      (conversation) => conversation.id,
    );

    const counterpartUsers = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        birthDate: users.birthDate,
        gender: users.gender,
      })
      .from(users)
      .where(
        and(
          inArray(users.id, counterpartIds),
          isNull(users.deletedAt),
          eq(users.isActive, true),
        ),
      );

    const counterpartPhotoRows = await this.db
      .select({
        userId: userPhotos.userId,
        id: userPhotos.id,
        url: userPhotos.url,
        position: userPhotos.position,
      })
      .from(userPhotos)
      .where(inArray(userPhotos.userId, counterpartIds))
      .orderBy(asc(userPhotos.position), asc(userPhotos.createdAt));

    const latestMessages = await this.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        senderId: messages.senderId,
        content: messages.content,
        messageType: messages.messageType,
        isRead: messages.isRead,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(inArray(messages.conversationId, conversationIds))
      .orderBy(desc(messages.createdAt));

    const counterpartById = new Map(
      counterpartUsers.map((user) => [user.id, user]),
    );
    const firstPhotoByUserId = new Map<string, { id: string; url: string }>();

    for (const photo of counterpartPhotoRows) {
      if (!firstPhotoByUserId.has(photo.userId)) {
        firstPhotoByUserId.set(photo.userId, {
          id: photo.id,
          url: photo.url,
        });
      }
    }

    const latestMessageByConversationId = new Map<
      string,
      {
        id: string;
        senderId: string;
        content: string;
        messageType: string;
        isRead: boolean;
        createdAt: Date;
      }
    >();

    for (const message of latestMessages) {
      if (!latestMessageByConversationId.has(message.conversationId)) {
        latestMessageByConversationId.set(message.conversationId, message);
      }
    }

    const items = conversationRows
      .map((conversation) => {
        const counterpartId =
          conversation.user1Id === userId
            ? conversation.user2Id
            : conversation.user1Id;
        const counterpart = counterpartById.get(counterpartId);

        if (!counterpart) {
          return null;
        }

        const latestMessage =
          latestMessageByConversationId.get(conversation.id) ?? null;
        const firstPhoto = firstPhotoByUserId.get(counterpart.id) ?? null;

        return {
          id: conversation.id,
          matchId: conversation.matchId,
          lastMessageAt: conversation.lastMessageAt,
          createdAt: conversation.createdAt,
          counterpart: {
            id: counterpart.id,
            firstName: counterpart.firstName,
            lastName: counterpart.lastName,
            gender: counterpart.gender,
            age: this.calculateAge(counterpart.birthDate),
            photo: firstPhoto,
          },
          latestMessage,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    return {
      count: items.length,
      conversations: items,
    };
  }

  async getMessages(
    userId: string,
    conversationId: string,
    requestedLimit?: number,
    before?: string,
  ) {
    await this.getConversationMembership(userId, conversationId);

    const limit = this.resolveLimit(
      requestedLimit,
      DEFAULT_MESSAGES_LIMIT,
      MAX_MESSAGES_LIMIT,
    );

    const beforeDate = before ? new Date(before) : null;

    const rows = await this.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        senderId: messages.senderId,
        content: messages.content,
        messageType: messages.messageType,
        isRead: messages.isRead,
        readAt: messages.readAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          beforeDate ? lt(messages.createdAt, beforeDate) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    const ordered = [...rows].reverse();
    const oldestMessage = rows.at(rows.length - 1) ?? null;

    return {
      count: ordered.length,
      messages: ordered,
      nextCursor: oldestMessage?.createdAt.toISOString() ?? null,
    };
  }

  async sendMessage(userId: string, dto: SendMessageDto) {
    const membership = await this.getConversationMembership(
      userId,
      dto.conversationId,
    );

    const [createdMessage] = await this.db
      .insert(messages)
      .values({
        conversationId: dto.conversationId,
        senderId: userId,
        content: dto.content.trim(),
        messageType: this.normalizeMessageType(dto.messageType),
      })
      .returning({
        id: messages.id,
        conversationId: messages.conversationId,
        senderId: messages.senderId,
        content: messages.content,
        messageType: messages.messageType,
        isRead: messages.isRead,
        readAt: messages.readAt,
        createdAt: messages.createdAt,
      });

    await this.db
      .update(conversations)
      .set({
        lastMessageAt: createdMessage.createdAt,
      })
      .where(eq(conversations.id, dto.conversationId));

    const counterpartId =
      membership.user1Id === userId ? membership.user2Id : membership.user1Id;

    return {
      message: createdMessage,
      participantIds: [membership.user1Id, membership.user2Id],
      counterpartId,
    };
  }

  async markConversationAsRead(userId: string, conversationId: string) {
    const membership = await this.getConversationMembership(
      userId,
      conversationId,
    );

    const updatedRows = await this.db
      .update(messages)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(
        and(
          eq(messages.conversationId, conversationId),
          ne(messages.senderId, userId),
          eq(messages.isRead, false),
        ),
      )
      .returning({
        id: messages.id,
      });

    return {
      conversationId,
      readCount: updatedRows.length,
      participantIds: [membership.user1Id, membership.user2Id],
    };
  }

  async getConversationParticipantIds(userId: string, conversationId: string) {
    const membership = await this.getConversationMembership(
      userId,
      conversationId,
    );

    return [membership.user1Id, membership.user2Id];
  }

  private async getConversationMembership(
    userId: string,
    conversationId: string,
  ): Promise<ConversationMembership> {
    const [conversation] = await this.db
      .select({
        conversationId: conversations.id,
        matchId: conversations.matchId,
        user1Id: matches.user1Id,
        user2Id: matches.user2Id,
      })
      .from(conversations)
      .innerJoin(matches, eq(conversations.matchId, matches.id))
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(matches.isActive, true),
          or(eq(matches.user1Id, userId), eq(matches.user2Id, userId)),
        ),
      )
      .limit(1);

    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    return conversation;
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

  private calculateAge(birthDate: string): number {
    const birth = new Date(birthDate);
    const now = new Date();

    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const hasBirthdayPassedThisYear =
      now.getUTCMonth() > birth.getUTCMonth() ||
      (now.getUTCMonth() === birth.getUTCMonth() &&
        now.getUTCDate() >= birth.getUTCDate());

    if (!hasBirthdayPassedThisYear) {
      age -= 1;
    }

    return age;
  }

  private normalizeMessageType(
    messageType: ChatMessageType | undefined,
  ): ChatMessageType {
    if (!messageType || !CHAT_MESSAGE_TYPES.includes(messageType)) {
      return 'text';
    }

    return messageType;
  }

  private resolveLimit(
    requested: number | undefined,
    fallback: number,
    max: number,
  ): number {
    if (!requested) {
      return fallback;
    }

    return Math.min(Math.max(requested, 1), max);
  }
}
