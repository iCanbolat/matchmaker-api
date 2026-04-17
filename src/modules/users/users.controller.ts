import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  ParseUUIDPipe,
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
import { ReorderPhotosDto } from './dto/reorder-photos.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly uploadService: UploadService,
  ) {}

  @Get('me')
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getMe(user.userId);
  }

  @Get('me/referral-code')
  getMyReferralCode(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getMyReferralCode(user.userId);
  }

  @Get('me/referrals')
  getMyReferrals(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getMyReferrals(user.userId);
  }

  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateMe(user.userId, dto);
  }

  @Post('me/photos')
  @UseInterceptors(
    FileInterceptor('file', {
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
  async uploadPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('File is required.');
    }

    const photoUrl = await this.uploadService.uploadUserPhoto(
      user.userId,
      file,
    );

    return this.usersService.addPhoto(user.userId, photoUrl);
  }

  @Delete('me/photos/:id')
  async deletePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) photoId: string,
  ) {
    const deletedPhoto = await this.usersService.deletePhoto(
      user.userId,
      photoId,
    );

    try {
      await this.uploadService.deleteUserPhoto(deletedPhoto.url);
    } catch {
      // Storage cleanup is best-effort and should not block API success.
    }

    return {
      deletedPhotoId: deletedPhoto.id,
    };
  }

  @Patch('me/photos/reorder')
  reorderPhotos(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReorderPhotosDto,
  ) {
    return this.usersService.reorderPhotos(user.userId, dto.photoIds);
  }

  @Post('me/freeze')
  freezeAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.freezeAccount(user.userId);
  }

  @Post('me/unfreeze')
  unfreezeAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.unfreezeAccount(user.userId);
  }

  @Delete('me')
  deleteAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.deleteAccount(user.userId);
  }
}
