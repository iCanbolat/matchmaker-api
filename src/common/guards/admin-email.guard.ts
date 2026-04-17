import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../config/env.schema';
import { type AuthenticatedUser } from '../types/authenticated-user.type';

@Injectable()
export class AdminEmailGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();

    const currentUserEmail = request.user?.email?.trim().toLowerCase();

    if (!currentUserEmail) {
      throw new ForbiddenException(
        'Admin access requires authenticated user email.',
      );
    }

    const adminEmails = this.configService
      .get('ADMIN_EMAILS', { infer: true })
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0);

    if (adminEmails.length === 0) {
      throw new ForbiddenException('Admin access is not configured.');
    }

    if (!adminEmails.includes(currentUserEmail)) {
      throw new ForbiddenException('Admin access required.');
    }

    return true;
  }
}
