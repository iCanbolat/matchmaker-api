import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { UploadService } from '../upload/upload.service';
import { RejectVerificationDto } from './dto/reject-verification.dto';
import { VerificationService } from './verification.service';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Controller('users/me/verify')
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(
    private readonly verificationService: VerificationService,
    private readonly uploadService: UploadService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('selfie', {
      storage: memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024,
      },
      fileFilter: (_request, file, callback) => {
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
          callback(
            new BadRequestException(
              'Only jpeg, png and webp files are allowed.',
            ) as Error,
            false,
          );
          return;
        }

        callback(null, true);
      },
    }),
  )
  async submitVerification(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Selfie file is required.');
    }

    const selfieUrl = await this.uploadService.uploadUserPhoto(
      user.userId,
      file,
    );

    return this.verificationService.submitVerification(user.userId, selfieUrl);
  }

  @Get()
  getVerificationStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.verificationService.getVerificationStatus(user.userId);
  }

  @Patch(':id/approve')
  approveVerification(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.verificationService.approveVerification(id);
  }

  @Patch(':id/reject')
  rejectVerification(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.verificationService.rejectVerification(id, dto.rejectionReason);
  }
}
