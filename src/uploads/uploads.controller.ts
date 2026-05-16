import { Controller, Post, UseInterceptors, UploadedFile, Body, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UploadsService } from './uploads.service';
import { memoryStorage } from 'multer';

@ApiTags('uploads')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post('avatar')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  uploadAvatar(@UploadedFile() file: Express.Multer.File) {
    return this.uploadsService.uploadFile(file, 'ife-food/avatars');
  }

  @Post('document')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  uploadDocument(@UploadedFile() file: Express.Multer.File, @Body('entityType') entityType: 'professional' | 'driver', @Body('entityId') entityId: string, @Body('docType') docType: string) {
    return this.uploadsService.uploadDocument(file, entityType, entityId, docType);
  }
}
