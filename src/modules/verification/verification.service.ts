import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { userVerifications, users } from '../../database/schema';

export type VerificationStatus = 'pending' | 'approved' | 'rejected';

@Injectable()
export class VerificationService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get db() {
    return this.databaseService.db;
  }

  async submitVerification(userId: string, selfieUrl: string) {
    const latest = await this.getLatestVerification(userId);

    if (latest?.status === 'pending') {
      throw new BadRequestException(
        'You already have a pending verification request.',
      );
    }

    if (latest?.status === 'approved') {
      throw new BadRequestException('Your account is already verified.');
    }

    const [verification] = await this.db
      .insert(userVerifications)
      .values({
        userId,
        selfieUrl,
        status: 'pending',
      })
      .returning({
        id: userVerifications.id,
        selfieUrl: userVerifications.selfieUrl,
        status: userVerifications.status,
        createdAt: userVerifications.createdAt,
      });

    return verification;
  }

  async getVerificationStatus(userId: string) {
    const latest = await this.getLatestVerification(userId);

    if (!latest) {
      return { status: 'none' as const, verification: null };
    }

    return {
      status: latest.status as VerificationStatus,
      verification: latest,
    };
  }

  async approveVerification(verificationId: string) {
    const [verification] = await this.db
      .select({
        id: userVerifications.id,
        userId: userVerifications.userId,
        status: userVerifications.status,
      })
      .from(userVerifications)
      .where(eq(userVerifications.id, verificationId))
      .limit(1);

    if (!verification) {
      throw new NotFoundException('Verification request not found.');
    }

    if (verification.status !== 'pending') {
      throw new BadRequestException('Verification is not in pending state.');
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(userVerifications)
        .set({
          status: 'approved',
          reviewedAt: new Date(),
        })
        .where(eq(userVerifications.id, verificationId));

      await tx
        .update(users)
        .set({
          isVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, verification.userId));
    });

    return { message: 'Verification approved.' };
  }

  async rejectVerification(verificationId: string, reason?: string) {
    const [verification] = await this.db
      .select({
        id: userVerifications.id,
        userId: userVerifications.userId,
        status: userVerifications.status,
      })
      .from(userVerifications)
      .where(eq(userVerifications.id, verificationId))
      .limit(1);

    if (!verification) {
      throw new NotFoundException('Verification request not found.');
    }

    if (verification.status !== 'pending') {
      throw new BadRequestException('Verification is not in pending state.');
    }

    await this.db
      .update(userVerifications)
      .set({
        status: 'rejected',
        rejectionReason: reason ?? null,
        reviewedAt: new Date(),
      })
      .where(eq(userVerifications.id, verificationId));

    await this.db
      .update(users)
      .set({
        isVerified: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, verification.userId));

    return { message: 'Verification rejected.' };
  }

  private async getLatestVerification(userId: string) {
    const [latest] = await this.db
      .select({
        id: userVerifications.id,
        selfieUrl: userVerifications.selfieUrl,
        status: userVerifications.status,
        rejectionReason: userVerifications.rejectionReason,
        reviewedAt: userVerifications.reviewedAt,
        createdAt: userVerifications.createdAt,
      })
      .from(userVerifications)
      .where(eq(userVerifications.userId, userId))
      .orderBy(desc(userVerifications.createdAt))
      .limit(1);

    return latest ?? null;
  }
}
