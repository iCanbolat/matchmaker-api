import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import * as appleSigninAuth from 'apple-signin-auth';
import { type Env } from '../../config/env.schema';

export type SocialIdentity = {
  provider: 'google' | 'apple';
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
};

@Injectable()
export class OauthIdentityService {
  private readonly googleClient = new OAuth2Client();

  constructor(private readonly configService: ConfigService<Env, true>) {}

  async verifyGoogleIdToken(idToken: string): Promise<SocialIdentity> {
    const clientId = this.getRequiredClientId('GOOGLE_CLIENT_ID');

    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: clientId,
      });
      const payload = ticket.getPayload();

      if (!payload) {
        throw new UnauthorizedException('Invalid Google identity token.');
      }

      const providerUserId = payload.sub;
      const email = payload.email ?? null;
      const emailVerified = payload.email_verified === true;

      if (!providerUserId || !email || !emailVerified) {
        throw new UnauthorizedException('Invalid Google identity token.');
      }

      return {
        provider: 'google',
        providerUserId,
        email,
        emailVerified,
      };
    } catch {
      throw new UnauthorizedException('Invalid Google identity token.');
    }
  }

  async verifyAppleIdToken(idToken: string): Promise<SocialIdentity> {
    const clientId = this.getRequiredClientId('APPLE_CLIENT_ID');

    try {
      const payload = await appleSigninAuth.verifyIdToken(idToken, {
        issuer: 'https://appleid.apple.com',
        audience: clientId,
      });

      const providerUserId = payload.sub;
      const email = payload.email ?? null;

      if (!providerUserId) {
        throw new UnauthorizedException('Invalid Apple identity token.');
      }

      return {
        provider: 'apple',
        providerUserId,
        email,
        emailVerified: this.getEmailVerified(payload.email_verified),
      };
    } catch {
      throw new UnauthorizedException('Invalid Apple identity token.');
    }
  }

  private getRequiredClientId(
    key: 'GOOGLE_CLIENT_ID' | 'APPLE_CLIENT_ID',
  ): string {
    const value = this.configService.get(key, { infer: true });

    if (!value) {
      throw new InternalServerErrorException(`${key} is not configured.`);
    }

    return value;
  }

  private getEmailVerified(claim: boolean | string | undefined): boolean {
    return claim === true || claim === 'true';
  }
}
