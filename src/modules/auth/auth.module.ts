import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { type Env } from '../../config/env.schema';
import { ReferralsModule } from '../referrals/referrals.module';
import { SettingsModule } from '../settings/settings.module';
import { SmsModule } from '../sms/sms.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OauthIdentityService } from './oauth-identity.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    SettingsModule,
    ReferralsModule,
    SmsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Env, true>) => ({
        secret: configService.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: {
          expiresIn: configService.get('JWT_ACCESS_EXPIRATION', {
            infer: true,
          }),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, OauthIdentityService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
