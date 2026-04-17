import { IsBoolean } from 'class-validator';

export class UpdatePublicRegistrationDto {
  @IsBoolean()
  enabled!: boolean;
}
