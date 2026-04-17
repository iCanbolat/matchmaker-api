import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, or } from 'drizzle-orm';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { type JwtPayload } from '../../common/types/jwt-payload.type';
import { type Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.service';
import { users } from '../../database/schema';
import { LoginDto } from './dto/login.dto';
import { type Gender, RegisterDto } from './dto/register.dto';
import { SocialAuthDto } from './dto/social-auth.dto';
import {
  OauthIdentityService,
  type SocialIdentity,
} from './oauth-identity.service';
import { ReferralBonusService } from '../referrals/referral-bonus.service';
import { SettingsService } from '../settings/settings.service';

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

@Injectable()
export class AuthService {
  constructor(
    private readonly databaseService: DatabaseService,
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
}
