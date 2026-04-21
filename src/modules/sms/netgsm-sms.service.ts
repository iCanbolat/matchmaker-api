import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Netgsm, { type OtpSmsResponse } from '@netgsm/sms';
import { type Env } from '../../config/env.schema';

export type NetgsmSendResult = {
  provider: 'netgsm';
  rawResponse: unknown;
};

@Injectable()
export class NetgsmSmsService {
  private readonly logger = new Logger(NetgsmSmsService.name);

  constructor(private readonly configService: ConfigService<Env, true>) {}

  async sendSms(
    phoneNumber: string,
    message: string,
  ): Promise<NetgsmSendResult> {
    const usercode = this.configService.get('NETGSM_USERCODE', { infer: true });
    const password = this.configService.get('NETGSM_PASSWORD', { infer: true });
    const msgheader = this.configService.get('NETGSM_MSGHEADER', {
      infer: true,
    });
    const appname = this.configService.get('NETGSM_APPNAME', { infer: true });

    if (!usercode || !password || !msgheader) {
      throw new InternalServerErrorException(
        'Netgsm credentials are not configured.',
      );
    }

    const client = this.createClient({
      usercode,
      password,
      appname,
    });

    try {
      const recipient = this.toNetgsmRecipient(phoneNumber);
      const response = await client.sendOtpSms({
        msgheader,
        msg: message,
        no: recipient,
      });

      return {
        provider: 'netgsm',
        rawResponse: response,
      };
    } catch (error) {
      const reason = this.describeNetgsmError(error);
      this.logger.error(`Netgsm send failed: ${reason}`);
      throw new InternalServerErrorException('SMS delivery failed.');
    }
  }

  private createClient(options: {
    usercode: string;
    password: string;
    appname?: string;
  }) {
    return new Netgsm({
      username: options.usercode,
      password: options.password,
      appname: options.appname,
    });
  }

  private toNetgsmRecipient(phoneNumber: string): string {
    const digits = phoneNumber.replace(/\D/g, '');

    if (digits.length === 12 && digits.startsWith('90')) {
      return digits.slice(2);
    }

    if (digits.length === 11 && digits.startsWith('0')) {
      return digits.slice(1);
    }

    if (digits.length === 10) {
      return digits;
    }

    throw new InternalServerErrorException('Invalid normalized phone number.');
  }

  private describeNetgsmError(error: unknown): string {
    if (this.isNetgsmError(error)) {
      return `${error.code}:${error.description}`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'unknown_netgsm_error';
  }

  private isNetgsmError(error: unknown): error is {
    code: string;
    description: string;
  } {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const candidate = error as Partial<OtpSmsResponse> & {
      description?: unknown;
    };

    return (
      typeof candidate.code === 'string' &&
      typeof candidate.description === 'string'
    );
  }
}
