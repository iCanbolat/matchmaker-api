import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppThrottlerGuard } from './common/performance/app-throttler.guard';
import { PerformanceModule } from './common/performance/performance.module';
import { type Env, validateEnv } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { BlocksModule } from './modules/blocks/blocks.module';
import { ChatModule } from './modules/chat/chat.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { MatchesModule } from './modules/matches/matches.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ProfileViewsModule } from './modules/profile-views/profile-views.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { UsersModule } from './modules/users/users.module';
import { VerificationModule } from './modules/verification/verification.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Env, true>) => [
        {
          name: 'default',
          ttl: configService.get('RATE_LIMIT_TTL_MS', { infer: true }),
          limit: configService.get('RATE_LIMIT_MAX', { infer: true }),
          blockDuration: configService.get('RATE_LIMIT_BLOCK_DURATION_MS', {
            infer: true,
          }),
        },
      ],
    }),
    PerformanceModule,
    DatabaseModule,
    AuthModule,
    BlocksModule,
    ChatModule,
    DiscoveryModule,
    MatchesModule,
    NotificationsModule,
    ProfileViewsModule,
    ReportsModule,
    SettingsModule,
    SubscriptionsModule,
    UsersModule,
    VerificationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
  ],
})
export class AppModule {}
