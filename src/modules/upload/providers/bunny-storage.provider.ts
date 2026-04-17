import { BadGatewayException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

type BunnyUploadParams = {
  file: Express.Multer.File;
  destination: string;
  zone: string;
  accessKey: string;
  pullZoneUrl: string;
  host: string;
};

type BunnyDeleteParams = {
  fileUrl: string;
  zone: string;
  accessKey: string;
  pullZoneUrl: string;
  host: string;
};

@Injectable()
export class BunnyStorageProvider {
  async upload(params: BunnyUploadParams): Promise<string> {
    const extension =
      extname(params.file.originalname || '').toLowerCase() || '.jpg';
    const fileName = `${Date.now()}-${randomUUID()}${extension}`;
    const relativePath = `${params.destination}/${fileName}`.replace(
      /\\/g,
      '/',
    );

    const uploadUrl = `https://${params.host}/${params.zone}/${relativePath}`;
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        AccessKey: params.accessKey,
        'Content-Type': params.file.mimetype,
      },
      body: new Uint8Array(params.file.buffer),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new BadGatewayException(
        `Bunny upload failed with status ${response.status}: ${details}`,
      );
    }

    return `${params.pullZoneUrl.replace(/\/+$/, '')}/${relativePath}`;
  }

  async delete(params: BunnyDeleteParams): Promise<void> {
    const normalizedPullZoneUrl = params.pullZoneUrl.replace(/\/+$/, '');

    if (!params.fileUrl.startsWith(`${normalizedPullZoneUrl}/`)) {
      return;
    }

    const relativePath = params.fileUrl.slice(normalizedPullZoneUrl.length + 1);
    const deleteUrl = `https://${params.host}/${params.zone}/${relativePath}`;
    const response = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        AccessKey: params.accessKey,
      },
    });

    if (!response.ok && response.status !== 404) {
      const details = await response.text();
      throw new BadGatewayException(
        `Bunny delete failed with status ${response.status}: ${details}`,
      );
    }
  }
}
