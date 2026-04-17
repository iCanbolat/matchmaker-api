import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminEmailGuard } from '../../common/guards/admin-email.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { UpdatePublicRegistrationDto } from './dto/update-public-registration.dto';
import { SettingsService } from './settings.service';

@Controller('admin/settings')
@UseGuards(JwtAuthGuard, AdminEmailGuard)
export class AdminSettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('public-registration')
  async getPublicRegistrationSetting() {
    const publicRegistrationEnabled =
      await this.settingsService.getPublicRegistrationEnabled();

    return {
      publicRegistrationEnabled,
    };
  }

  @Patch('public-registration')
  async updatePublicRegistrationSetting(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePublicRegistrationDto,
  ) {
    const publicRegistrationEnabled =
      await this.settingsService.setPublicRegistrationEnabled(dto.enabled);

    return {
      publicRegistrationEnabled,
      updatedBy: user.email,
    };
  }
}
