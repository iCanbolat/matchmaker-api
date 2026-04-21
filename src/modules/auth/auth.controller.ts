import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { LoginDto } from './dto/login.dto';
import { PhoneLoginContinueDto } from './dto/phone-login-continue.dto';
import { PhoneRegisterContinueDto } from './dto/phone-register-continue.dto';
import { RequestPhoneCodeDto } from './dto/request-phone-code.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { SocialAuthDto } from './dto/social-auth.dto';
import { VerifyPhoneCodeDto } from './dto/verify-phone-code.dto';
import { AuthService } from './auth.service';

const ONE_MINUTE_IN_MS = 60_000;
const TWO_MINUTES_IN_MS = 120_000;
const FIVE_MINUTES_IN_MS = 300_000;

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({
    default: {
      limit: 3,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: FIVE_MINUTES_IN_MS,
    },
  })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({
    default: {
      limit: 6,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: TWO_MINUTES_IN_MS,
    },
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('google')
  @Throttle({
    default: {
      limit: 15,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: TWO_MINUTES_IN_MS,
    },
  })
  authenticateWithGoogle(@Body() dto: SocialAuthDto) {
    return this.authService.authenticateWithGoogle(dto);
  }

  @Post('apple')
  @Throttle({
    default: {
      limit: 15,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: TWO_MINUTES_IN_MS,
    },
  })
  authenticateWithApple(@Body() dto: SocialAuthDto) {
    return this.authService.authenticateWithApple(dto);
  }

  @Post('phone/request-code')
  @Throttle({
    default: {
      limit: 4,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: TWO_MINUTES_IN_MS,
    },
  })
  requestPhoneCode(@Body() dto: RequestPhoneCodeDto) {
    return this.authService.requestPhoneCode(dto.phoneNumber);
  }

  @Post('phone/verify-code')
  @Throttle({
    default: {
      limit: 10,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: TWO_MINUTES_IN_MS,
    },
  })
  verifyPhoneCode(@Body() dto: VerifyPhoneCodeDto) {
    return this.authService.verifyPhoneCode(dto.phoneNumber, dto.code);
  }

  @Post('phone/login')
  @Throttle({
    default: {
      limit: 12,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: TWO_MINUTES_IN_MS,
    },
  })
  loginWithPhoneContinuation(@Body() dto: PhoneLoginContinueDto) {
    return this.authService.loginWithPhoneContinuation(dto.verificationToken);
  }

  @Post('phone/register')
  @Throttle({
    default: {
      limit: 8,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: TWO_MINUTES_IN_MS,
    },
  })
  registerWithPhoneContinuation(@Body() dto: PhoneRegisterContinueDto) {
    return this.authService.registerWithPhoneContinuation(dto);
  }

  @Post('refresh')
  @Throttle({
    default: {
      limit: 30,
      ttl: ONE_MINUTE_IN_MS,
      blockDuration: ONE_MINUTE_IN_MS,
    },
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.logout(user.userId);
  }
}
