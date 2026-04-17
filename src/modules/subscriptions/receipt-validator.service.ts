import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuth } from 'google-auth-library';
import { type Env } from '../../config/env.schema';
import { VerifyReceiptDto } from './dto/verify-receipt.dto';
import { type ValidatedSubscriptionReceipt } from './subscriptions.types';

type AppleVerifyReceiptResponse = {
  status?: number;
  environment?: string;
  latest_receipt_info?: Array<Record<string, unknown>>;
  receipt?: {
    in_app?: Array<Record<string, unknown>>;
  };
};

type AppleTransaction = {
  storeTransactionId: string;
  startsAt: Date;
  expiresAt: Date;
  isCancelled: boolean;
};

@Injectable()
export class ReceiptValidatorService {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  async validateReceipt(
    dto: VerifyReceiptDto,
  ): Promise<ValidatedSubscriptionReceipt> {
    if (dto.platform === 'ios') {
      return this.validateAppleReceipt(dto);
    }

    if (dto.platform === 'android') {
      return this.validateGoogleReceipt(dto);
    }

    return this.validateWebReceipt(dto);
  }

  private async validateAppleReceipt(
    dto: VerifyReceiptDto,
  ): Promise<ValidatedSubscriptionReceipt> {
    if (!dto.receiptData) {
      throw new BadRequestException(
        'receiptData is required for iOS receipt validation.',
      );
    }

    const sharedSecret = this.configService.get('APPLE_SHARED_SECRET', {
      infer: true,
    });

    if (!sharedSecret) {
      throw new BadRequestException('APPLE_SHARED_SECRET is not configured.');
    }

    let payload = await this.requestAppleValidation(
      dto.isSandbox
        ? 'https://sandbox.itunes.apple.com/verifyReceipt'
        : 'https://buy.itunes.apple.com/verifyReceipt',
      dto.receiptData,
      sharedSecret,
    );

    if (!dto.isSandbox && payload.status === 21007) {
      payload = await this.requestAppleValidation(
        'https://sandbox.itunes.apple.com/verifyReceipt',
        dto.receiptData,
        sharedSecret,
      );
    }

    if (payload.status !== 0) {
      throw new BadRequestException(
        `Apple receipt validation failed with status ${payload.status ?? 'unknown'}.`,
      );
    }

    const latestTransaction = this.extractLatestAppleTransaction(payload);

    if (!latestTransaction) {
      throw new BadRequestException(
        'Apple receipt does not contain a valid subscription transaction.',
      );
    }

    return {
      storeTransactionId: latestTransaction.storeTransactionId,
      startsAt: latestTransaction.startsAt,
      expiresAt: latestTransaction.expiresAt,
      isCancelled:
        latestTransaction.isCancelled ||
        latestTransaction.expiresAt <= new Date(),
      raw: {
        provider: 'apple',
        environment: payload.environment ?? null,
        status: payload.status ?? null,
      },
    };
  }

  private async validateGoogleReceipt(
    dto: VerifyReceiptDto,
  ): Promise<ValidatedSubscriptionReceipt> {
    if (!dto.purchaseToken) {
      throw new BadRequestException(
        'purchaseToken is required for Android receipt validation.',
      );
    }

    if (!dto.subscriptionId) {
      throw new BadRequestException(
        'subscriptionId is required for Android receipt validation.',
      );
    }

    const packageName = this.configService.get('GOOGLE_PLAY_PACKAGE_NAME', {
      infer: true,
    });
    const serviceAccountRaw = this.configService.get(
      'GOOGLE_SERVICE_ACCOUNT_KEY',
      {
        infer: true,
      },
    );

    if (!packageName) {
      throw new BadRequestException(
        'GOOGLE_PLAY_PACKAGE_NAME is not configured.',
      );
    }

    if (!serviceAccountRaw) {
      throw new BadRequestException(
        'GOOGLE_SERVICE_ACCOUNT_KEY is not configured.',
      );
    }

    const credentials = this.parseGoogleServiceAccount(serviceAccountRaw);
    const accessToken = await this.getGoogleAccessToken(credentials);

    const endpoint =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/` +
      `${encodeURIComponent(dto.purchaseToken)}`;

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new BadRequestException(
        `Google receipt validation failed. status=${response.status} body=${responseText}`,
      );
    }

    let payload: unknown;

    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new BadRequestException(
        'Google receipt validation returned invalid JSON.',
      );
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new BadRequestException(
        'Google receipt validation response has invalid shape.',
      );
    }

    const record = payload as Record<string, unknown>;
    const expiresAt = this.extractGoogleExpiryFromResponse(record);

    if (!expiresAt) {
      throw new BadRequestException(
        'Google receipt does not contain a valid subscription expiry.',
      );
    }

    const startsAt =
      this.parseDate(this.readString(record.startTime)) ?? new Date();
    const subscriptionState =
      this.readString(record.subscriptionState) ?? 'UNKNOWN';
    const latestOrderId =
      this.readString(record.latestOrderId) ??
      dto.storeTransactionId ??
      dto.purchaseToken;

    return {
      storeTransactionId: latestOrderId,
      startsAt,
      expiresAt,
      isCancelled: [
        'SUBSCRIPTION_STATE_CANCELED',
        'SUBSCRIPTION_STATE_EXPIRED',
        'SUBSCRIPTION_STATE_REVOKED',
      ].includes(subscriptionState),
      raw: {
        provider: 'google',
        packageName,
        subscriptionId: dto.subscriptionId,
        subscriptionState,
      },
    };
  }

  private validateWebReceipt(
    dto: VerifyReceiptDto,
  ): ValidatedSubscriptionReceipt {
    if (!dto.storeTransactionId) {
      throw new BadRequestException(
        'storeTransactionId is required for web receipt validation.',
      );
    }

    if (!dto.expiresAt) {
      throw new BadRequestException(
        'expiresAt is required for web receipt validation.',
      );
    }

    const startsAt = dto.startsAt ? new Date(dto.startsAt) : new Date();
    const expiresAt = new Date(dto.expiresAt);

    if (!this.isValidDate(startsAt) || !this.isValidDate(expiresAt)) {
      throw new BadRequestException('Invalid startsAt or expiresAt value.');
    }

    if (expiresAt <= startsAt) {
      throw new BadRequestException('expiresAt must be later than startsAt.');
    }

    return {
      storeTransactionId: dto.storeTransactionId,
      startsAt,
      expiresAt,
      isCancelled: false,
      raw: {
        provider: 'web',
      },
    };
  }

  private async requestAppleValidation(
    endpoint: string,
    receiptData: string,
    sharedSecret: string,
  ): Promise<AppleVerifyReceiptResponse> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        'receipt-data': receiptData,
        password: sharedSecret,
        'exclude-old-transactions': true,
      }),
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new BadRequestException(
        `Apple receipt validation request failed. status=${response.status} body=${responseText}`,
      );
    }

    let payload: unknown;

    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new BadRequestException(
        'Apple receipt validation returned invalid JSON.',
      );
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new BadRequestException(
        'Apple receipt validation response has invalid shape.',
      );
    }

    return payload as AppleVerifyReceiptResponse;
  }

  private extractLatestAppleTransaction(
    payload: AppleVerifyReceiptResponse,
  ): AppleTransaction | null {
    const receiptInfo = Array.isArray(payload.latest_receipt_info)
      ? payload.latest_receipt_info
      : [];
    const inAppInfo = Array.isArray(payload.receipt?.in_app)
      ? payload.receipt?.in_app
      : [];
    const candidates = [...receiptInfo, ...inAppInfo];

    let latest: AppleTransaction | null = null;

    for (const candidate of candidates) {
      const parsed = this.parseAppleTransaction(candidate);

      if (!parsed) {
        continue;
      }

      if (!latest || parsed.expiresAt > latest.expiresAt) {
        latest = parsed;
      }
    }

    return latest;
  }

  private parseAppleTransaction(value: unknown): AppleTransaction | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const transactionId =
      this.readString(row.transaction_id) ??
      this.readString(row.original_transaction_id);
    const expiresAt = this.parseDate(this.readString(row.expires_date_ms));

    if (!transactionId || !expiresAt) {
      return null;
    }

    const startsAt =
      this.parseDate(this.readString(row.purchase_date_ms)) ?? new Date();

    return {
      storeTransactionId: transactionId,
      startsAt,
      expiresAt,
      isCancelled:
        this.readString(row.cancellation_date_ms) !== null ||
        this.readString(row.cancellation_date) !== null,
    };
  }

  private extractGoogleExpiryFromResponse(
    payload: Record<string, unknown>,
  ): Date | null {
    const lineItems = payload.lineItems;

    if (!Array.isArray(lineItems)) {
      return null;
    }

    let latestExpiry: Date | null = null;

    for (const lineItem of lineItems) {
      if (typeof lineItem !== 'object' || lineItem === null) {
        continue;
      }

      const expiry = this.parseDate(
        this.readString((lineItem as Record<string, unknown>).expiryTime),
      );

      if (!expiry) {
        continue;
      }

      if (!latestExpiry || expiry > latestExpiry) {
        latestExpiry = expiry;
      }
    }

    return latestExpiry;
  }

  private parseGoogleServiceAccount(raw: string): Record<string, unknown> {
    const normalized = raw.trim();

    if (normalized.length === 0) {
      throw new BadRequestException('GOOGLE_SERVICE_ACCOUNT_KEY is empty.');
    }

    let jsonText = normalized;

    if (!normalized.startsWith('{')) {
      try {
        jsonText = Buffer.from(normalized, 'base64').toString('utf8');
      } catch {
        throw new BadRequestException(
          'GOOGLE_SERVICE_ACCOUNT_KEY must be JSON or base64-encoded JSON.',
        );
      }
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new BadRequestException(
        'GOOGLE_SERVICE_ACCOUNT_KEY contains invalid JSON.',
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new BadRequestException(
        'GOOGLE_SERVICE_ACCOUNT_KEY has invalid structure.',
      );
    }

    const record = parsed as Record<string, unknown>;

    if (
      this.readString(record.client_email) === null ||
      this.readString(record.private_key) === null
    ) {
      throw new BadRequestException(
        'GOOGLE_SERVICE_ACCOUNT_KEY must include client_email and private_key.',
      );
    }

    return record;
  }

  private async getGoogleAccessToken(
    credentials: Record<string, unknown>,
  ): Promise<string> {
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    const client = await auth.getClient();
    const tokenResponse: unknown = await client.getAccessToken();

    if (typeof tokenResponse === 'string' && tokenResponse.length > 0) {
      return tokenResponse;
    }

    if (
      tokenResponse &&
      typeof tokenResponse === 'object' &&
      'token' in tokenResponse &&
      typeof tokenResponse.token === 'string' &&
      tokenResponse.token.length > 0
    ) {
      return tokenResponse.token;
    }

    throw new BadRequestException('Unable to obtain Google access token.');
  }

  private parseDate(value: string | null): Date | null {
    if (!value) {
      return null;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric) && numeric > 0) {
      const millis = value.length <= 10 ? numeric * 1000 : numeric;
      const fromMillis = new Date(millis);

      if (this.isValidDate(fromMillis)) {
        return fromMillis;
      }
    }

    const parsed = new Date(value);

    if (!this.isValidDate(parsed)) {
      return null;
    }

    return parsed;
  }

  private isValidDate(value: Date): boolean {
    return Number.isFinite(value.getTime());
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return null;
    }

    return trimmed;
  }
}
