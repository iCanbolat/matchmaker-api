import { IsString, Matches } from 'class-validator';

export class RequestPhoneCodeDto {
  @IsString()
  @Matches(/^[+0-9\s()-]{10,20}$/, {
    message: 'phoneNumber must be a valid phone number string.',
  })
  phoneNumber!: string;
}
