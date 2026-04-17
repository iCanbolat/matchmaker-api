import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const uploadStrategy =
    process.env.UPLOAD_STRATEGY ??
    (process.env.NODE_ENV === 'production' ? 'bunny' : 'local');

  if (uploadStrategy === 'local') {
    const uploadDir = process.env.UPLOAD_DIR ?? 'uploads';
    const uploadPath = join(process.cwd(), uploadDir);
    await mkdir(uploadPath, { recursive: true });
    app.useStaticAssets(uploadPath, { prefix: '/uploads/' });
  }

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
