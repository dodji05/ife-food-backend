import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { promises as fs } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as sharp from 'sharp';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_TYPES       = [...ALLOWED_IMAGE_TYPES, 'application/pdf'];
const MAX_SIZE_BYTES       = 10 * 1024 * 1024; // 10 Mo
const IMAGE_MAX_WIDTH      = 1200;
const IMAGE_QUALITY        = 80;

@Injectable()
export class UploadsService {
  private readonly uploadsRoot: string;
  private readonly appUrl: string;

  constructor(config: ConfigService, private prisma: PrismaService) {
    this.uploadsRoot = join(process.cwd(), 'uploads');
    this.appUrl = (config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  /**
   * Enregistre un fichier sur disque.
   * - Images → redimensionnées (max 1200 px) + converties en WebP (qualité 80).
   * - PDF   → stocké tel quel.
   * Retourne l'URL publique : APP_URL/uploads/<folder>/<uuid>.<ext>
   */
  async uploadFile(file: Express.Multer.File, folder = 'general'): Promise<string> {
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('Type non autorisé — jpg, png, webp, gif, pdf uniquement');
    }
    if (file.size > MAX_SIZE_BYTES) {
      throw new BadRequestException('Fichier trop volumineux (max 10 Mo)');
    }

    const dir = join(this.uploadsRoot, folder);
    await fs.mkdir(dir, { recursive: true });

    let buffer: Buffer;
    let ext: string;

    if (file.mimetype === 'application/pdf') {
      buffer = file.buffer;
      ext    = 'pdf';
    } else {
      buffer = await sharp(file.buffer)
        .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: IMAGE_QUALITY })
        .toBuffer();
      ext = 'webp';
    }

    const filename = `${uuidv4()}.${ext}`;
    await fs.writeFile(join(dir, filename), buffer);

    return `${this.appUrl}/uploads/${folder}/${filename}`;
  }

  async uploadDocument(
    file: Express.Multer.File,
    entityType: 'professional' | 'driver',
    entityId: string,
    docType: string,
  ) {
    const url = await this.uploadFile(file, `documents/${entityType}`);
    const entityRelation = entityType === 'professional'
      ? { professionalId: entityId }
      : { driverId: entityId };
    await this.prisma.document.create({ data: { ...entityRelation, type: docType, url } });
    return { url };
  }
}
