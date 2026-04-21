import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, or } from 'drizzle-orm';
import { compare, hash } from 'bcryptjs';
import { randomBytes, randomInt } from 'node:crypto';
import { AppCacheService } from '../../common/performance/app-cache.service';
import { type JwtPayload } from '../../common/types/jwt-payload.type';
import { type Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.service';
import { users } from '../../database/schema';
import { LoginDto } from './dto/login.dto';
import { PhoneRegisterContinueDto } from './dto/phone-register-continue.dto';
import { type Gender, RegisterDto } from './dto/register.dto';
import { SocialAuthDto } from './dto/social-auth.dto';
import {
  OauthIdentityService,
  type SocialIdentity,
} from './oauth-identity.service';
import { ReferralBonusService } from '../referrals/referral-bonus.service';
import { SettingsService } from '../settings/settings.service';
import { SmsService } from '../sms/sms.service';

type SafeUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  birthDate: string;
  gender: string;
  bio: string | null;
  referralCode: string;
  referredBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

type SocialProfile = {
  firstName: string;
  lastName: string | null;
  birthDate: string;
  gender: Gender;
};

type RefreshJwtPayload = JwtPayload & {
  exp: number;
};

type PhoneOtpCacheEntry = {
  codeHash: string;
  expiresAt: number;
  resendAvailableAt: number;
  attemptsRemaining: number;
};

type VerifiedPhoneCacheEntry = {
  phoneNumber: string;
  verifiedAt: number;
};

const PHONE_OTP_KEY_PREFIX = 'auth:phone-otp';
const PHONE_VERIFICATION_KEY_PREFIX = 'auth:phone-verified';
const PHONE_OTP_MAX_ATTEMPTS = 5;
const PHONE_EMAIL_DOMAIN = 'phone.matchmaker.local';

@Injectable()
export class AuthService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly appCacheService: AppCacheService,
    private readonly smsService: SmsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<Env, true>,
    private readonly oauthIdentityService: OauthIdentityService,
    private readonly settingsService: SettingsService,
    private readonly referralBonusService: ReferralBonusService,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async register(dto: RegisterDto) {
    const [existingUser] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, dto.email))
      .limit(1);

    if (existingUser) {
      throw new BadRequestException('Email already in use.');
    }

    const referrerId = await this.resolveReferrerId(dto.referralCode);

    const passwordHash = await hash(dto.password, 12);
    const referralCode = await this.generateUniqueReferralCode();

    const createdUser = await this.db.transaction(async (tx) => {
      const [newUser] = await tx
        .insert(users)
        .values({
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName ?? null,
          birthDate: dto.birthDate,
          gender: dto.gender,
          referralCode,
          referredBy: referrerId,
        })
        .returning({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          birthDate: users.birthDate,
          gender: users.gender,
          bio: users.bio,
          referralCode: users.referralCode,
          referredBy: users.referredBy,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        });

      if (!newUser) {
        throw new BadRequestException('User could not be created.');
      }

      if (referrerId) {
        if (!dto.referralCode) {
          throw new BadRequestException('Referral code is invalid.');
        }

        await this.referralBonusService.completeReferral(tx, {
          referrerId,
          referredId: newUser.id,
          referralCodeUsed: dto.referralCode,
        });
      }

      return newUser;
    });

    const tokens = await this.issueAuthTokens(
      createdUser.id,
      createdUser.email,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: createdUser,
    };
  }

  async authenticateWithGoogle(dto: SocialAuthDto) {
    const identity = await this.oauthIdentityService.verifyGoogleIdToken(
      dto.idToken,
    );

    return this.authenticateWithSocialIdentity(identity, dto);
  }

  async authenticateWithApple(dto: SocialAuthDto) {
    const identity = await this.oauthIdentityService.verifyAppleIdToken(
      dto.idToken,
    );

    return this.authenticateWithSocialIdentity(identity, dto);
  }

  async requestPhoneCode(rawPhoneNumber: string) {
    const phoneNumber = this.normalizePhoneNumber(rawPhoneNumber);

    if (this.isDevPhoneMockBypassEnabled()) {
      return {
        success: true,
        expiresInSeconds: 0,
        resendAvailableInSeconds: 0,
        mockBypassEnabled: true,
      };
    }

    const otpKey = this.getPhoneOtpKey(phoneNumber);
    const now = Date.now();

    const existing = await this.appCacheService.get<PhoneOtpCacheEntry>(otpKey);

    if (existing && existing.resendAvailableAt > now) {
      const waitSeconds = Math.ceil((existing.resendAvailableAt - now) / 1000);

      throw new BadRequestException(
        `Please wait ${waitSeconds} seconds before requesting another code.`,
      );
    }

    const otpLength = this.configService.get('SMS_OTP_LENGTH', {
      infer: true,
    });
    const ttlSeconds = this.configService.get('SMS_OTP_TTL_SECONDS', {
      infer: true,
    });
    const cooldownSeconds = this.configService.get('SMS_OTP_COOLDOWN_SECONDS', {
      infer: true,
    });

    const code = this.generateOtpCode(otpLength);
    const codeHash = await hash(code, 10);

    await this.appCacheService.set<PhoneOtpCacheEntry>(
      otpKey,
      {
        codeHash,
        expiresAt: now + ttlSeconds * 1000,
        resendAvailableAt: now + cooldownSeconds * 1000,
        attemptsRemaining: PHONE_OTP_MAX_ATTEMPTS,
      },
      ttlSeconds,
    );

    await this.smsService.sendSms({
      phoneNumber,
      message: this.buildOtpMessage(code, ttlSeconds),
    });

    return {
      success: true,
      expiresInSeconds: ttlSeconds,
      resendAvailableInSeconds: cooldownSeconds,
      mockBypassEnabled: false,
    };
  }

  async verifyPhoneCode(rawPhoneNumber: string, code?: string) {
    const phoneNumber = this.normalizePhoneNumber(rawPhoneNumber);

    if (this.isDevPhoneMockBypassEnabled()) {
      const verificationToken =
        await this.issuePhoneVerificationToken(phoneNumber);

      return {
        success: true,
        verificationToken,
        phoneNumber,
        mockBypassEnabled: true,
      };
    }

    const otpKey = this.getPhoneOtpKey(phoneNumber);
    const cached = await this.appCacheService.get<PhoneOtpCacheEntry>(otpKey);

    if (!code) {
      throw new BadRequestException(
        'Verification code is required in non-development environments.',
      );
    }

    if (!cached || cached.expiresAt <= Date.now()) {
      await this.appCacheService.del(otpKey);
      throw new BadRequestException(
        'Verification code expired. Please request a new code.',
      );
    }

    const isMatch = await compare(code, cached.codeHash);

    if (!isMatch) {
      const attemptsRemaining = cached.attemptsRemaining - 1;

      if (attemptsRemaining <= 0) {
        await this.appCacheService.del(otpKey);
        throw new UnauthorizedException(
          'Too many failed attempts. Please request a new code.',
        );
      }

      const ttlSeconds = Math.max(
        1,
        Math.ceil((cached.expiresAt - Date.now()) / 1000),
      );

      await this.appCacheService.set<PhoneOtpCacheEntry>(
        otpKey,
        {
          ...cached,
          attemptsRemaining,
        },
        ttlSeconds,
      );

      throw new UnauthorizedException(
        `Invalid verification code. ${attemptsRemaining} attempts remaining.`,
      );
    }

    await this.appCacheService.del(otpKey);

    const verificationToken =
      await this.issuePhoneVerificationToken(phoneNumber);

    return {
      success: true,
      verificationToken,
      phoneNumber,
      mockBypassEnabled: false,
    };
  }

  async loginWithPhoneContinuation(verificationToken: string) {
    const phoneNumber =
      await this.consumePhoneVerificationToken(verificationToken);

    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        birthDate: users.birthDate,
        gender: users.gender,
        bio: users.bio,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.phoneNumber, phoneNumber))
      .limit(1);

    if (!user || user.deletedAt) {
      throw new BadRequestException(
        'No account found for this phone number. Please register first.',
      );
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is inactive.');
    }

    const tokens = await this.issueAuthTokens(user.id, user.email);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        birthDate: user.birthDate,
        gender: user.gender,
        bio: user.bio,
        referralCode: user.referralCode,
        referredBy: user.referredBy,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      } satisfies SafeUser,
    };
  }

  async registerWithPhoneContinuation(dto: PhoneRegisterContinueDto) {
    const phoneNumber = await this.consumePhoneVerificationToken(
      dto.verificationToken,
    );

    const [existingPhoneOwner] = await this.db
      .select({
        id: users.id,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.phoneNumber, phoneNumber))
      .limit(1);

    if (existingPhoneOwner?.deletedAt) {
      throw new BadRequestException(
        'This phone number belongs to a deleted account and cannot be reused.',
      );
    }

    if (existingPhoneOwner) {
      throw new BadRequestException('Phone number already in use.');
    }

    const referrerId = await this.resolveReferrerId(dto.referralCode);
    const referralCode = await this.generateUniqueReferralCode();
    const passwordHash = await hash(randomBytes(32).toString('base64url'), 12);
    const generatedEmail = await this.generateUniquePhoneEmail(phoneNumber);

    const createdUser = await this.db.transaction(async (tx) => {
      const [newUser] = await tx
        .insert(users)
        .values({
          email: generatedEmail,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName ?? null,
          birthDate: dto.birthDate,
          gender: dto.gender,
          referralCode,
          referredBy: referrerId,
          phoneNumber,
        })
        .returning({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          birthDate: users.birthDate,
          gender: users.gender,
          bio: users.bio,
          referralCode: users.referralCode,
          referredBy: users.referredBy,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        });

      if (!newUser) {
        throw new BadRequestException('User could not be created.');
      }

      if (referrerId) {
        if (!dto.referralCode) {
          throw new BadRequestException('Referral code is invalid.');
        }

        await this.referralBonusService.completeReferral(tx, {
          referrerId,
          referredId: newUser.id,
          referralCodeUsed: dto.referralCode,
        });
      }

      return newUser;
    });

    const tokens = await this.issueAuthTokens(
      createdUser.id,
      createdUser.email,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: createdUser,
    };
  }

  async login(dto: LoginDto) {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        firstName: users.firstName,
        lastName: users.lastName,
        birthDate: users.birthDate,
        gender: users.gender,
        bio: users.bio,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(and(eq(users.email, dto.email), isNull(users.deletedAt)))
      .limit(1);

    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const passwordMatches = await compare(dto.password, user.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const tokens = await this.issueAuthTokens(user.id, user.email);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        birthDate: user.birthDate,
        gender: user.gender,
        bio: user.bio,
        referralCode: user.referralCode,
        referredBy: user.referredBy,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      } satisfies SafeUser,
    };
  }

  async refresh(refreshToken: string) {
    const payload = await this.verifyRefreshToken(refreshToken);

    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
        refreshTokenHash: users.refreshTokenHash,
        refreshTokenExpiresAt: users.refreshTokenExpiresAt,
      })
      .from(users)
      .where(and(eq(users.id, payload.sub), isNull(users.deletedAt)))
      .limit(1);

    if (!user || !user.isActive || user.deletedAt || !user.refreshTokenHash) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    const tokenMatches = await compare(refreshToken, user.refreshTokenHash);

    if (!tokenMatches) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    if (
      user.refreshTokenExpiresAt &&
      user.refreshTokenExpiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Refresh token has expired.');
    }

    const tokens = await this.issueAuthTokens(user.id, user.email);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async logout(userId: string) {
    await this.db
      .update(users)
      .set({
        refreshTokenHash: null,
        refreshTokenExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return {
      success: true,
    };
  }

  private async issueAuthTokens(
    userId: string,
    email: string,
  ): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: userId,
      email,
    };

    const accessToken = await this.signAccessToken(payload);
    const refreshToken = await this.signRefreshToken(payload);

    await this.persistRefreshToken(userId, refreshToken);

    return {
      accessToken,
      refreshToken,
    };
  }

  private async signAccessToken(payload: JwtPayload): Promise<string> {
    return this.jwtService.signAsync(payload);
  }

  private async signRefreshToken(payload: JwtPayload): Promise<string> {
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRATION', {
        infer: true,
      }),
    });
  }

  private async verifyRefreshToken(
    refreshToken: string,
  ): Promise<RefreshJwtPayload> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required.');
    }

    try {
      const payload = await this.jwtService.verifyAsync<
        JwtPayload & { exp?: number }
      >(refreshToken, {
        secret: this.configService.get('JWT_REFRESH_SECRET', {
          infer: true,
        }),
      });

      if (!payload.sub || !payload.email || typeof payload.exp !== 'number') {
        throw new UnauthorizedException('Invalid refresh token payload.');
      }

      return {
        sub: payload.sub,
        email: payload.email,
        exp: payload.exp,
      };
    } catch {
      throw new UnauthorizedException('Invalid refresh token.');
    }
  }

  private async persistRefreshToken(
    userId: string,
    refreshToken: string,
  ): Promise<void> {
    const decodedToken = await this.verifyRefreshToken(refreshToken);

    const refreshTokenHash = await hash(refreshToken, 12);
    const refreshTokenExpiresAt = new Date(decodedToken.exp * 1000);

    await this.db
      .update(users)
      .set({
        refreshTokenHash,
        refreshTokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  private async generateUniqueReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = randomBytes(8)
        .toString('base64url')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 8)
        .toUpperCase();

      if (candidate.length < 8) {
        continue;
      }

      const [existing] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.referralCode, candidate))
        .limit(1);

      if (!existing) {
        return candidate;
      }
    }

    throw new BadRequestException('Could not generate unique referral code.');
  }

  private async resolveReferrerId(
    referralCode: string | undefined,
  ): Promise<string | null> {
    if (referralCode) {
      const [referrer] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.referralCode, referralCode), isNull(users.deletedAt)),
        )
        .limit(1);

      if (!referrer) {
        throw new BadRequestException('Referral code is invalid.');
      }

      return referrer.id;
    }

    const publicRegistrationEnabled =
      await this.settingsService.getPublicRegistrationEnabled();

    if (!publicRegistrationEnabled) {
      throw new BadRequestException(
        'Referral code is required while public registration is closed.',
      );
    }

    return null;
  }

  private async authenticateWithSocialIdentity(
    identity: SocialIdentity,
    dto: SocialAuthDto,
  ) {
    const providerCondition =
      identity.provider === 'google'
        ? eq(users.googleId, identity.providerUserId)
        : eq(users.appleId, identity.providerUserId);

    const identityMatchCondition = identity.email
      ? or(providerCondition, eq(users.email, identity.email))
      : providerCondition;

    const [existingUser] = await this.db
      .select({
        id: users.id,
        email: users.email,
        googleId: users.googleId,
        appleId: users.appleId,
        firstName: users.firstName,
        lastName: users.lastName,
        birthDate: users.birthDate,
        gender: users.gender,
        bio: users.bio,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(and(identityMatchCondition, isNull(users.deletedAt)))
      .limit(1);

    if (existingUser) {
      if (!existingUser.isActive || existingUser.deletedAt) {
        throw new UnauthorizedException('Account is inactive.');
      }

      const values: Partial<typeof users.$inferInsert> = {};

      if (identity.provider === 'google' && !existingUser.googleId) {
        values.googleId = identity.providerUserId;
      }

      if (identity.provider === 'apple' && !existingUser.appleId) {
        values.appleId = identity.providerUserId;
      }

      if (Object.keys(values).length > 0) {
        values.updatedAt = new Date();
        await this.db
          .update(users)
          .set(values)
          .where(eq(users.id, existingUser.id));
      }

      const tokens = await this.issueAuthTokens(
        existingUser.id,
        existingUser.email,
      );

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: existingUser.id,
          email: existingUser.email,
          firstName: existingUser.firstName,
          lastName: existingUser.lastName,
          birthDate: existingUser.birthDate,
          gender: existingUser.gender,
          bio: existingUser.bio,
          referralCode: existingUser.referralCode,
          referredBy: existingUser.referredBy,
          createdAt: existingUser.createdAt,
          updatedAt: existingUser.updatedAt,
        } satisfies SafeUser,
      };
    }

    if (!identity.email) {
      throw new BadRequestException(
        'Email is required for first-time social sign-in.',
      );
    }

    const publicRegistrationEnabled =
      await this.settingsService.getPublicRegistrationEnabled();

    if (!publicRegistrationEnabled) {
      throw new BadRequestException(
        'Public registration is closed. Social sign-in is available only for existing accounts.',
      );
    }

    const [existingEmailOwner] = await this.db
      .select({
        id: users.id,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.email, identity.email))
      .limit(1);

    if (existingEmailOwner?.deletedAt) {
      throw new BadRequestException(
        'This email belongs to a deleted account and cannot be reused.',
      );
    }

    if (existingEmailOwner) {
      throw new BadRequestException('Email already in use.');
    }

    const socialProfile = this.extractRequiredSocialProfile(dto);
    const referrerId = await this.resolveReferrerId(dto.referralCode);
    const referralCode = await this.generateUniqueReferralCode();
    const passwordHash = await hash(randomBytes(32).toString('base64url'), 12);

    const values: typeof users.$inferInsert = {
      email: identity.email,
      passwordHash,
      firstName: socialProfile.firstName,
      lastName: socialProfile.lastName,
      birthDate: socialProfile.birthDate,
      gender: socialProfile.gender,
      referralCode,
      referredBy: referrerId,
    };

    if (identity.provider === 'google') {
      values.googleId = identity.providerUserId;
    }

    if (identity.provider === 'apple') {
      values.appleId = identity.providerUserId;
    }

    const createdUser = await this.db.transaction(async (tx) => {
      const [newUser] = await tx.insert(users).values(values).returning({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        birthDate: users.birthDate,
        gender: users.gender,
        bio: users.bio,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      });

      if (!newUser) {
        throw new BadRequestException('User could not be created.');
      }

      if (referrerId) {
        if (!dto.referralCode) {
          throw new BadRequestException('Referral code is invalid.');
        }

        await this.referralBonusService.completeReferral(tx, {
          referrerId,
          referredId: newUser.id,
          referralCodeUsed: dto.referralCode,
        });
      }

      return newUser;
    });

    const tokens = await this.issueAuthTokens(
      createdUser.id,
      createdUser.email,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: createdUser,
    };
  }

  private extractRequiredSocialProfile(dto: SocialAuthDto): SocialProfile {
    if (!dto.firstName || !dto.birthDate || !dto.gender) {
      throw new BadRequestException(
        'firstName, birthDate and gender are required for first-time social sign-in.',
      );
    }

    return {
      firstName: dto.firstName,
      lastName: dto.lastName ?? null,
      birthDate: dto.birthDate,
      gender: dto.gender,
    };
  }

  private normalizePhoneNumber(rawPhoneNumber: string): string {
    let national = rawPhoneNumber.replace(/\D/g, '');

    if (national.startsWith('90') && national.length >= 12) {
      national = national.slice(2);
    }

    if (national.startsWith('0') && national.length >= 11) {
      national = national.slice(1);
    }

    if (national.length !== 10 || !national.startsWith('5')) {
      throw new BadRequestException(
        'Invalid phone number format. Please provide a valid Turkish mobile number.',
      );
    }

    return `90${national}`;
  }

  private isDevPhoneMockBypassEnabled(): boolean {
    const isDevelopment =
      this.configService.get('NODE_ENV', { infer: true }) === 'development';
    const mockBypassEnabled = this.configService.get(
      'SMS_DEV_MOCK_BYPASS_VERIFICATION',
      {
        infer: true,
      },
    );

    return isDevelopment && mockBypassEnabled;
  }

  private async issuePhoneVerificationToken(
    phoneNumber: string,
  ): Promise<string> {
    const verificationToken = randomBytes(24).toString('base64url');
    const verificationTtlSeconds = this.configService.get(
      'SMS_PHONE_VERIFICATION_TOKEN_TTL_SECONDS',
      {
        infer: true,
      },
    );

    await this.appCacheService.set<VerifiedPhoneCacheEntry>(
      this.getVerifiedPhoneKey(verificationToken),
      {
        phoneNumber,
        verifiedAt: Date.now(),
      },
      verificationTtlSeconds,
    );

    return verificationToken;
  }

  private async consumePhoneVerificationToken(
    verificationToken: string,
  ): Promise<string> {
    const key = this.getVerifiedPhoneKey(verificationToken);
    const cached = await this.appCacheService.get<VerifiedPhoneCacheEntry>(key);

    if (!cached) {
      throw new BadRequestException(
        'Phone verification token expired or invalid. Please verify again.',
      );
    }

    await this.appCacheService.del(key);
    return cached.phoneNumber;
  }

  private async generateUniquePhoneEmail(phoneNumber: string): Promise<string> {
    const localPartBase = `phone_${phoneNumber}`;

    for (let attempt = 0; attempt < 10; attempt++) {
      const localPart =
        attempt === 0
          ? localPartBase
          : `${localPartBase}_${randomBytes(2).toString('hex')}`;
      const candidate = `${localPart}@${PHONE_EMAIL_DOMAIN}`;

      const [existing] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, candidate))
        .limit(1);

      if (!existing) {
        return candidate;
      }
    }

    throw new BadRequestException('Could not allocate a unique phone account.');
  }

  private generateOtpCode(length: number): string {
    const min = 10 ** (length - 1);
    const max = 10 ** length;

    return randomInt(min, max).toString();
  }

  private buildOtpMessage(code: string, ttlSeconds: number): string {
    const ttlMinutes = Math.max(1, Math.floor(ttlSeconds / 60));
    return `Matchmaker verification code: ${code}. Valid for ${ttlMinutes} minute(s).`;
  }

  private getPhoneOtpKey(phoneNumber: string): string {
    return `${PHONE_OTP_KEY_PREFIX}:${phoneNumber}`;
  }

  private getVerifiedPhoneKey(token: string): string {
    return `${PHONE_VERIFICATION_KEY_PREFIX}:${token}`;
  }
}
