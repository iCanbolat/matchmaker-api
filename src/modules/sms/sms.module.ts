import { Module } from '@nestjs/common';
import { NetgsmSmsService } from './netgsm-sms.service';
import { SmsService } from './sms.service';

@Module({
  providers: [SmsService, NetgsmSmsService],
  exports: [SmsService],
})
export class SmsModule {}
