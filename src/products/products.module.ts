import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  // UploadsModule exporte UploadsService — utilisé par uploadImage()
  // pour pousser vers Cloudinary (mime/size validation déjà en place).
  imports: [UploadsModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
