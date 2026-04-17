import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';

const ONE_MINUTE_IN_MS = 60_000;

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @Throttle({
    default: {
      limit: 12,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: ONE_MINUTE_IN_MS,
    },
  })
  createReport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReportDto,
  ) {
    return this.reportsService.createReport(user.userId, dto);
  }
}
