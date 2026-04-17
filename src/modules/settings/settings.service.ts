import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { type Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.service';
import { systemSettings } from '../../database/schema';

const PUBLIC_REGISTRATION_ENABLED_KEY = 'public_registration_enabled';

@Injectable()
export class SettingsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  private get db() {
    return this.databaseService.db;
  }

  async getPublicRegistrationEnabled(): Promise<boolean> {
    const [setting] = await this.db
      .select({
        value: systemSettings.value,
      })
      .from(systemSettings)
      .where(eq(systemSettings.key, PUBLIC_REGISTRATION_ENABLED_KEY))
      .limit(1);

    if (typeof setting?.value === 'boolean') {
      return setting.value;
    }

    return this.configService.get('PUBLIC_REGISTRATION_ENABLED', {
      infer: true,
    });
  }

  async setPublicRegistrationEnabled(enabled: boolean): Promise<boolean> {
    await this.db
      .insert(systemSettings)
      .values({
        key: PUBLIC_REGISTRATION_ENABLED_KEY,
        value: enabled,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: enabled,
          updatedAt: new Date(),
        },
      });

    return enabled;
  }
}
