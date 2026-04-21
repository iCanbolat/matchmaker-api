import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class VerifyPhoneCodeDto {
  @IsString()
  @Matches(/^[+0-9\s()-]{10,20}$/, {
    message: 'phoneNumber must be a valid phone number string.',
  })
  phoneNumber!: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(6)
  @Matches(/^\d{4,6}$/, {
    message: 'code must contain 4 to 6 digits.',
  })
  code?: string;
}
