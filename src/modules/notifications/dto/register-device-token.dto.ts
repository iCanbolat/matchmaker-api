import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { DEVICE_PLATFORMS, type DevicePlatform } from '../notifications.types';

export class RegisterDeviceTokenDto {
  @IsIn(DEVICE_PLATFORMS)
  platform!: DevicePlatform;

  @IsString()
  @MinLength(16)
  @MaxLength(512)
  token!: string;
}
