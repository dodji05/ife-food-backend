import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UploadsService {
  constructor(private config: ConfigService, private prisma: PrismaService) {
    cloudinary.config({
      cloud_name: config.get('CLOUDINARY_CLOUD_NAME'),
      api_key: config.get('CLOUDINARY_API_KEY'),
      api_secret: config.get('CLOUDINARY_API_SECRET'),
    });
  }

  async uploadFile(file: Express.Multer.File, folder: string = 'ife-food'): Promise<string> {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.mimetype)) throw new BadRequestException('File type not allowed');
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException('File too large (max 10MB)');

    const result = await new Promise<any>((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder, public_id: uuidv4(), resource_type: 'auto' },
        (err, res) => err ? reject(err) : resolve(res)
      ).end(file.buffer);
    });
    return result.secure_url;
  }

  async uploadDocument(file: Express.Multer.File, entityType: 'professional' | 'driver', entityId: string, docType: string) {
    const url = await this.uploadFile(file, `ife-food/documents/${entityType}`);
    const entityRelation = entityType === 'professional' ? { professionalId: entityId } : { driverId: entityId };
    await this.prisma.document.create({ data: { ...entityRelation, type: docType, url } });
    return { url };
  }
}
