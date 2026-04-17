import { Module } from '@nestjs/common';
import { AdminEmailGuard } from '../../common/guards/admin-email.guard';
import { AdminSettingsController } from './admin-settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [AdminSettingsController],
  providers: [SettingsService, AdminEmailGuard],
  exports: [SettingsService],
})
export class SettingsModule {}
