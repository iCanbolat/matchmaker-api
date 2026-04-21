import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Gender } from './register.dto';

export class PhoneRegisterContinueDto {
  @IsString()
  @MinLength(20)
  verificationToken!: string;

  @IsString()
  @MaxLength(100)
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsDateString()
  birthDate!: string;

  @IsEnum(Gender)
  gender!: Gender;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  referralCode?: string;
}
