import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const requestUser =
      typeof req.user === 'object' && req.user !== null
        ? (req.user as { userId?: unknown })
        : null;
    const authenticatedUserId =
      typeof requestUser?.userId === 'string' ? requestUser.userId : null;

    if (authenticatedUserId) {
      return Promise.resolve(`user:${authenticatedUserId}`);
    }

    const requestHeaders =
      typeof req.headers === 'object' && req.headers !== null
        ? (req.headers as Record<string, unknown>)
        : {};
    const forwardedFor = requestHeaders['x-forwarded-for'];

    if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
      const firstForwardedIp = forwardedFor.split(',')[0]?.trim();

      if (firstForwardedIp) {
        return Promise.resolve(`ip:${firstForwardedIp}`);
      }
    }

    const requestSocket =
      typeof req.socket === 'object' && req.socket !== null
        ? (req.socket as { remoteAddress?: unknown })
        : null;
    const fallbackIp =
      (typeof req.ip === 'string' && req.ip) ||
      (typeof requestSocket?.remoteAddress === 'string'
        ? requestSocket.remoteAddress
        : 'unknown');

    return Promise.resolve(`ip:${fallbackIp}`);
  }
}
