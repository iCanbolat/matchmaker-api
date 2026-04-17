import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { matches, userPhotos, users } from '../../database/schema';

@Injectable()
export class MatchesService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get db() {
    return this.databaseService.db;
  }

  async listMatches(userId: string) {
    await this.ensureUserExists(userId);

    const activeMatches = await this.db
      .select({
        id: matches.id,
        user1Id: matches.user1Id,
        user2Id: matches.user2Id,
        matchedAt: matches.matchedAt,
      })
      .from(matches)
      .where(
        and(
          eq(matches.isActive, true),
          or(eq(matches.user1Id, userId), eq(matches.user2Id, userId)),
        ),
      )
      .orderBy(desc(matches.matchedAt));

    if (activeMatches.length === 0) {
      return {
        count: 0,
        matches: [],
      };
    }

    const counterpartIds = Array.from(
      new Set(
        activeMatches.map((match) =>
          match.user1Id === userId ? match.user2Id : match.user1Id,
        ),
      ),
    );

    const counterpartUsers = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        gender: users.gender,
        bio: users.bio,
        birthDate: users.birthDate,
      })
      .from(users)
      .where(
        and(
          inArray(users.id, counterpartIds),
          isNull(users.deletedAt),
          eq(users.isActive, true),
        ),
      );

    const photos = await this.db
      .select({
        userId: userPhotos.userId,
        id: userPhotos.id,
        url: userPhotos.url,
        position: userPhotos.position,
      })
      .from(userPhotos)
      .where(inArray(userPhotos.userId, counterpartIds))
      .orderBy(asc(userPhotos.position), asc(userPhotos.createdAt));

    const usersById = new Map(counterpartUsers.map((user) => [user.id, user]));
    const photosByUserId = new Map<
      string,
      Array<{ id: string; url: string; position: number }>
    >();

    for (const photo of photos) {
      const existingPhotos = photosByUserId.get(photo.userId) ?? [];
      existingPhotos.push({
        id: photo.id,
        url: photo.url,
        position: photo.position,
      });
      photosByUserId.set(photo.userId, existingPhotos);
    }

    const matchItems = activeMatches
      .map((match) => {
        const counterpartId =
          match.user1Id === userId ? match.user2Id : match.user1Id;
        const counterpart = usersById.get(counterpartId);

        if (!counterpart) {
          return null;
        }

        return {
          id: match.id,
          matchedAt: match.matchedAt,
          user: {
            id: counterpart.id,
            firstName: counterpart.firstName,
            lastName: counterpart.lastName,
            gender: counterpart.gender,
            bio: counterpart.bio,
            age: this.calculateAge(counterpart.birthDate),
            photos: photosByUserId.get(counterpart.id) ?? [],
          },
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    return {
      count: matchItems.length,
      matches: matchItems,
    };
  }

  async unmatch(userId: string, matchId: string) {
    const [match] = await this.db
      .select({
        id: matches.id,
        user1Id: matches.user1Id,
        user2Id: matches.user2Id,
        isActive: matches.isActive,
      })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);

    if (!match) {
      throw new NotFoundException('Match not found.');
    }

    if (match.user1Id !== userId && match.user2Id !== userId) {
      throw new NotFoundException('Match not found.');
    }

    if (!match.isActive) {
      return {
        id: match.id,
        isActive: false,
      };
    }

    await this.db
      .update(matches)
      .set({
        isActive: false,
      })
      .where(eq(matches.id, match.id));

    return {
      id: match.id,
      isActive: false,
    };
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
}
