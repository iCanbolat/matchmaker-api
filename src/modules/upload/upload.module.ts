import { Module } from '@nestjs/common';
import { BunnyStorageProvider } from './providers/bunny-storage.provider';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { UploadService } from './upload.service';

@Module({
  providers: [UploadService, LocalStorageProvider, BunnyStorageProvider],
  exports: [UploadService],
})
export class UploadModule {}
