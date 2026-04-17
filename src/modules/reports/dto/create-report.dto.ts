import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { REPORT_REASONS, type ReportReason } from '../reports.constants';

export class CreateReportDto {
  @IsUUID('4')
  userId!: string;

  @IsIn(REPORT_REASONS)
  reason!: ReportReason;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  description?: string;
}
