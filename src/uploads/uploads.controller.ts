import { Controller, Post, UseInterceptors, UploadedFile, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UploadsService } from './uploads.service';
import { memoryStorage } from 'multer';

const MAX_SIZE = 5 * 1024 * 1024; // 5 Mo
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const VALID_DOC_TYPES = ['DRIVER_LICENSE', 'ID_CARD', 'BUSINESS_LICENSE', 'BANK_STATEMENT', 'VEHICLE_REGISTRATION'];

const fileFilter = (_req: any, file: Express.Multer.File, cb: any) => {
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    return cb(new BadRequestException('Type de fichier non autorisé (jpeg, png, webp, pdf uniquement)'), false);
  }
  cb(null, true);
};

@ApiTags('uploads')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post('avatar')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), fileFilter, limits: { fileSize: MAX_SIZE } }))
  uploadAvatar(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Fichier requis');
    return this.uploadsService.uploadFile(file, 'ife-food/avatars');
  }

  @Post('document')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), fileFilter, limits: { fileSize: MAX_SIZE } }))
  uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body('entityType') entityType: 'professional' | 'driver',
    @Body('entityId') entityId: string,
    @Body('docType') docType: string,
  ) {
    if (!file) throw new BadRequestException('Fichier requis');
    if (!VALID_DOC_TYPES.includes(docType)) throw new BadRequestException('Type de document invalide');
    if (!['professional', 'driver'].includes(entityType)) throw new BadRequestException('entityType invalide');
    return this.uploadsService.uploadDocument(file, entityType, entityId, docType);
  }
}
