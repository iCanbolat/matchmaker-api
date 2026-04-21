import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../config/env.schema';
import { NetgsmSmsService } from './netgsm-sms.service';

export type SendSmsInput = {
  phoneNumber: string;
  message: string;
};

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly netgsmSmsService: NetgsmSmsService,
  ) {}

  async sendSms(input: SendSmsInput): Promise<void> {
    const enabled = this.configService.get('SMS_ENABLED', { infer: true });

    if (!enabled) {
      this.logger.log(
        `SMS provider disabled; skipped delivery to ${this.maskPhone(input.phoneNumber)}.`,
      );
      return;
    }

    await this.netgsmSmsService.sendSms(input.phoneNumber, input.message);
  }

  private maskPhone(phoneNumber: string): string {
    if (phoneNumber.length <= 4) {
      return phoneNumber;
    }

    return `${'*'.repeat(Math.max(0, phoneNumber.length - 4))}${phoneNumber.slice(-4)}`;
  }
}
