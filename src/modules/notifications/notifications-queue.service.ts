import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { type Env } from '../../config/env.schema';
import { PushService } from './push.service';
import { type PushDeliveryJobPayload } from './notifications.types';

const NOTIFICATIONS_QUEUE_NAME = 'notification.queue';

@Injectable()
export class NotificationsQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsQueueService.name);
  private readonly queueEnabled: boolean;

  private queue: Queue<PushDeliveryJobPayload> | null = null;
  private worker: Worker<PushDeliveryJobPayload> | null = null;

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly pushService: PushService,
  ) {
    this.queueEnabled = this.configService.get('NOTIFICATIONS_QUEUE_ENABLED', {
      infer: true,
    });

    if (!this.queueEnabled) {
      return;
    }

    const connection = this.createConnection();

    this.queue = new Queue<PushDeliveryJobPayload>(NOTIFICATIONS_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    });

    this.worker = new Worker<PushDeliveryJobPayload>(
      NOTIFICATIONS_QUEUE_NAME,
      async (job) => {
        await this.pushService.deliver(job.data);
      },
      { connection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `Notification push job failed. id=${job?.id ?? 'unknown'} error=${error.message}`,
      );
    });

    this.worker.on('error', (error) => {
      this.logger.warn(`Notification queue worker error: ${error.message}`);
    });
  }

  async enqueuePush(payload: PushDeliveryJobPayload): Promise<void> {
    if (!this.queueEnabled || !this.queue) {
      await this.pushService.deliver(payload);
      return;
    }

    await this.queue.add('push-delivery', payload);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private createConnection() {
    const host = this.configService.get('REDIS_HOST', { infer: true });
    const port = this.configService.get('REDIS_PORT', { infer: true });
    const db = this.configService.get('REDIS_DB', { infer: true });
    const password = this.configService.get('REDIS_PASSWORD', {
      infer: true,
    });

    if (password && password.length > 0) {
      return {
        host,
        port,
        db,
        password,
      };
    }

    return {
      host,
      port,
      db,
    };
  }
}
