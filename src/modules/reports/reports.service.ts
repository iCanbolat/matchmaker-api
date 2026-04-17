import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { reports, users } from '../../database/schema';
import { CreateReportDto } from './dto/create-report.dto';

@Injectable()
export class ReportsService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get db() {
    return this.databaseService.db;
  }

  async createReport(reporterId: string, dto: CreateReportDto) {
    const reportedId = dto.userId;

    if (reporterId === reportedId) {
      throw new BadRequestException('You cannot report yourself.');
    }

    const description = dto.description?.trim() ?? null;

    if (dto.reason === 'other' && (!description || description.length < 5)) {
      throw new BadRequestException(
        'Description is required for reason "other".',
      );
    }

    await Promise.all([
      this.ensureUserExists(reporterId),
      this.ensureUserExists(reportedId),
    ]);

    const [existingPendingReport] = await this.db
      .select({
        id: reports.id,
        reportedUserId: reports.reportedId,
        reason: reports.reason,
        description: reports.description,
        status: reports.status,
        createdAt: reports.createdAt,
      })
      .from(reports)
      .where(
        and(
          eq(reports.reporterId, reporterId),
          eq(reports.reportedId, reportedId),
          eq(reports.status, 'pending'),
        ),
      )
      .orderBy(desc(reports.createdAt))
      .limit(1);

    if (existingPendingReport) {
      return {
        ...existingPendingReport,
        alreadyReported: true,
      };
    }

    const [created] = await this.db
      .insert(reports)
      .values({
        reporterId,
        reportedId,
        reason: dto.reason,
        description,
        status: 'pending',
      })
      .returning({
        id: reports.id,
        reportedUserId: reports.reportedId,
        reason: reports.reason,
        description: reports.description,
        status: reports.status,
        createdAt: reports.createdAt,
      });

    return {
      ...created,
      alreadyReported: false,
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
          eq(users.isFrozen, false),
        ),
      )
      .limit(1);

    if (!user) {
      throw new NotFoundException('User not found.');
    }
  }
}
