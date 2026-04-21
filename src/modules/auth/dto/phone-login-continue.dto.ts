import { IsString, MinLength } from 'class-validator';

export class PhoneLoginContinueDto {
  @IsString()
  @MinLength(20)
  verificationToken!: string;
}
