import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../config/env.schema';
import { BunnyStorageProvider } from './providers/bunny-storage.provider';
import { LocalStorageProvider } from './providers/local-storage.provider';

@Injectable()
export class UploadService {
  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly localStorageProvider: LocalStorageProvider,
    private readonly bunnyStorageProvider: BunnyStorageProvider,
  ) {}

  async uploadUserPhoto(
    userId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    const destination = `users/${userId}`;
    const strategy = this.resolveStorageStrategy();

    if (strategy === 'local') {
      const uploadDir = this.configService.get('UPLOAD_DIR', { infer: true });
      return this.localStorageProvider.upload(file, destination, uploadDir);
    }

    return this.bunnyStorageProvider.upload({
      file,
      destination,
      zone: this.getRequiredValue('BUNNY_STORAGE_ZONE'),
      accessKey: this.getRequiredValue('BUNNY_ACCESS_KEY'),
      pullZoneUrl: this.getRequiredValue('BUNNY_PULL_ZONE_URL'),
      host: this.configService.get('BUNNY_STORAGE_HOST', { infer: true }),
    });
  }

  async deleteUserPhoto(fileUrl: string): Promise<void> {
    const strategy = this.resolveStorageStrategy();

    if (strategy === 'local') {
      const uploadDir = this.configService.get('UPLOAD_DIR', { infer: true });
      await this.localStorageProvider.delete(fileUrl, uploadDir);
      return;
    }

    await this.bunnyStorageProvider.delete({
      fileUrl,
      zone: this.getRequiredValue('BUNNY_STORAGE_ZONE'),
      accessKey: this.getRequiredValue('BUNNY_ACCESS_KEY'),
      pullZoneUrl: this.getRequiredValue('BUNNY_PULL_ZONE_URL'),
      host: this.configService.get('BUNNY_STORAGE_HOST', { infer: true }),
    });
  }

  private resolveStorageStrategy(): 'local' | 'bunny' {
    const configured = this.configService.get('UPLOAD_STRATEGY', {
      infer: true,
    });

    if (configured) {
      return configured;
    }

    const nodeEnv = this.configService.get('NODE_ENV', { infer: true });

    return nodeEnv === 'production' ? 'bunny' : 'local';
  }

  private getRequiredValue(
    key: 'BUNNY_STORAGE_ZONE' | 'BUNNY_ACCESS_KEY' | 'BUNNY_PULL_ZONE_URL',
  ): string {
    const value = this.configService.get(key, { infer: true });

    if (!value) {
      throw new InternalServerErrorException(`${key} is not configured.`);
    }

    return value;
  }
}
