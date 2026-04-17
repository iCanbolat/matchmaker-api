import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import {
  createConfiguration,
  DefaultApi,
  Notification,
  ServerConfiguration,
} from '@onesignal/node-onesignal';
import { DatabaseService } from '../../database/database.service';
import { notificationDeviceTokens } from '../../database/schema';
import { type Env } from '../../config/env.schema';
import { type PushDeliveryJobPayload } from './notifications.types';

const ONESIGNAL_MAX_RECIPIENTS_PER_REQUEST = 2000;

type OneSignalClientContext = {
  appId: string;
  client: DefaultApi;
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private hasLoggedMissingOneSignalConfig = false;
  private oneSignalClientContext: OneSignalClientContext | null = null;
  private oneSignalClientCacheKey: string | null = null;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async deliver(payload: PushDeliveryJobPayload) {
    const tokens = await this.db
      .select({
        id: notificationDeviceTokens.id,
        token: notificationDeviceTokens.deviceToken,
        platform: notificationDeviceTokens.platform,
      })
      .from(notificationDeviceTokens)
      .where(
        and(
          eq(notificationDeviceTokens.userId, payload.userId),
          eq(notificationDeviceTokens.isActive, true),
        ),
      );

    if (tokens.length === 0) {
      return {
        deliveredCount: 0,
        skippedCount: 0,
      };
    }

    const pushEnabled = this.configService.get('PUSH_DELIVERY_ENABLED', {
      infer: true,
    });

    if (!pushEnabled) {
      return {
        deliveredCount: 0,
        skippedCount: tokens.length,
      };
    }

    const oneSignalClientContext = this.getOneSignalClientContext();

    if (!oneSignalClientContext) {
      return {
        deliveredCount: 0,
        skippedCount: tokens.length,
      };
    }

    const oneSignalTargetTokens = tokens.filter((token) =>
      this.isOneSignalPushPlatform(token.platform),
    );

    if (oneSignalTargetTokens.length === 0) {
      return {
        deliveredCount: 0,
        skippedCount: tokens.length,
      };
    }

    let deliveredCount = 0;
    const targetIds = oneSignalTargetTokens.map((token) => token.token);

    for (const idBatch of this.chunk(
      targetIds,
      ONESIGNAL_MAX_RECIPIENTS_PER_REQUEST,
    )) {
      const delivered = await this.sendBatchWithOneSignal(
        oneSignalClientContext,
        idBatch,
        payload,
      );

      if (delivered > 0) {
        deliveredCount += delivered;
      }
    }

    const boundedDeliveredCount = Math.min(
      deliveredCount,
      oneSignalTargetTokens.length,
    );

    return {
      deliveredCount: boundedDeliveredCount,
      skippedCount: tokens.length - boundedDeliveredCount,
    };
  }

  private async sendBatchWithOneSignal(
    oneSignalClientContext: OneSignalClientContext,
    includeSubscriptionIds: string[],
    payload: PushDeliveryJobPayload,
  ): Promise<number> {
    const notification = new Notification();
    notification.app_id = oneSignalClientContext.appId;
    notification.target_channel = 'push';
    notification.include_subscription_ids = includeSubscriptionIds;
    notification.headings = {
      en: payload.title,
    };
    notification.contents = {
      en: payload.body ?? payload.title,
    };
    notification.data = {
      ...(payload.data ?? {}),
      notificationId: payload.notificationId,
      notificationType: payload.type,
    };

    try {
      const response =
        await oneSignalClientContext.client.createNotification(notification);

      if (response.errors) {
        this.logger.warn(
          `OneSignal push response contains errors: ${this.safeSerialize(response.errors)}`,
        );
      }

      const invalidRecipientCount = this.extractInvalidRecipientCount(
        response.errors,
      );

      return Math.max(includeSubscriptionIds.length - invalidRecipientCount, 0);
    } catch (error) {
      this.logger.warn(
        `OneSignal push request error: ${this.extractErrorMessage(error)}`,
      );

      return 0;
    }
  }

  private isOneSignalPushPlatform(platform: string): boolean {
    return platform === 'ios' || platform === 'android';
  }

  private getOneSignalClientContext(): OneSignalClientContext | null {
    const appId = this.configService.get('ONESIGNAL_APP_ID', {
      infer: true,
    });
    const restApiKey = this.configService.get('ONESIGNAL_REST_API_KEY', {
      infer: true,
    });

    if (!appId || !restApiKey) {
      if (!this.hasLoggedMissingOneSignalConfig) {
        this.logger.warn(
          'OneSignal configuration is missing. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY to enable push delivery.',
        );
        this.hasLoggedMissingOneSignalConfig = true;
      }

      return null;
    }

    const apiBaseUrl = this.configService
      .get('ONESIGNAL_API_BASE_URL', {
        infer: true,
      })
      .replace(/\/+$/, '');
    const nextCacheKey = `${apiBaseUrl}|${restApiKey}|${appId}`;

    if (
      this.oneSignalClientContext &&
      this.oneSignalClientCacheKey === nextCacheKey
    ) {
      return this.oneSignalClientContext;
    }

    const configuration = createConfiguration({
      restApiKey,
      baseServer: new ServerConfiguration(apiBaseUrl, {}),
    });

    this.oneSignalClientContext = {
      appId,
      client: new DefaultApi(configuration),
    };
    this.oneSignalClientCacheKey = nextCacheKey;

    return this.oneSignalClientContext;
  }

  private extractInvalidRecipientCount(errors: unknown): number {
    if (typeof errors !== 'object' || errors === null) {
      return 0;
    }

    const knownErrorKeys = [
      'invalid_subscription_ids',
      'invalid_player_ids',
      'invalid_aliases',
      'invalid_external_user_ids',
      'invalid_email_tokens',
      'invalid_phone_numbers',
    ];

    let count = 0;

    for (const key of knownErrorKeys) {
      count += this.countNestedValues((errors as Record<string, unknown>)[key]);
    }

    return count;
  }

  private countNestedValues(value: unknown): number {
    if (Array.isArray(value)) {
      return value.length;
    }

    if (typeof value === 'object' && value !== null) {
      let total = 0;

      for (const nestedValue of Object.values(
        value as Record<string, unknown>,
      )) {
        total += this.countNestedValues(nestedValue);
      }

      return total;
    }

    return 0;
  }

  private extractErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return this.safeSerialize(error);
    }

    const maybeStatusCode =
      'statusCode' in error
        ? (error as { statusCode?: unknown }).statusCode
        : null;
    const maybeBody =
      'body' in error ? (error as { body?: unknown }).body : null;

    const details: string[] = [error.message];

    if (typeof maybeStatusCode === 'number') {
      details.push(`status=${maybeStatusCode}`);
    }

    if (maybeBody !== null && maybeBody !== undefined) {
      details.push(`body=${this.safeSerialize(maybeBody)}`);
    }

    return details.join(' ');
  }

  private safeSerialize(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private chunk(values: string[], size: number): string[][] {
    const chunks: string[][] = [];

    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }

    return chunks;
  }
}
