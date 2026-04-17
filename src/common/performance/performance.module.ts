import { Global, Module } from '@nestjs/common';
import { AppCacheService } from './app-cache.service';
import { AppThrottlerGuard } from './app-throttler.guard';

@Global()
@Module({
  providers: [AppCacheService, AppThrottlerGuard],
  exports: [AppCacheService, AppThrottlerGuard],
})
export class PerformanceModule {}
