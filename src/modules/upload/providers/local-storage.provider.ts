import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

@Injectable()
export class LocalStorageProvider {
  async upload(
    file: Express.Multer.File,
    destination: string,
    uploadDir: string,
  ): Promise<string> {
    const extension = extname(file.originalname || '').toLowerCase() || '.jpg';
    const fileName = `${Date.now()}-${randomUUID()}${extension}`;
    const relativePath = `${destination}/${fileName}`.replace(/\\/g, '/');
    const absolutePath = join(process.cwd(), uploadDir, relativePath);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.buffer);

    return `/uploads/${relativePath}`;
  }

  async delete(fileUrl: string, uploadDir: string): Promise<void> {
    if (!fileUrl.startsWith('/uploads/')) {
      return;
    }

    const relativePath = fileUrl.replace(/^\/uploads\//, '');
    const absolutePath = join(process.cwd(), uploadDir, relativePath);

    await rm(absolutePath, { force: true });
  }
}
