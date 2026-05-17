import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateProductDto, UpdateProductDto, CreateCategoryDto } from './dto/product.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private uploads: UploadsService,
  ) {}

  async createCategory(userId: string, dto: CreateCategoryDto) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException('Professional profile not found');
    return this.prisma.productCategory.create({ data: { professionalId: prof.id, name: dto.name, icon: dto.icon } });
  }

  async getCategories(professionalId: string) {
    return this.prisma.productCategory.findMany({ where: { professionalId }, orderBy: { sortOrder: 'asc' }, include: { products: { where: { isAvailable: true } } } });
  }

  async createProduct(userId: string, dto: CreateProductDto) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException('Professional profile not found');

    // If commission is fixed amount, add it to price
    const commissionConfig = await this.prisma.platformConfig.findUnique({ where: { key: 'commission' } });
    const config = commissionConfig?.value as any;
    const displayPrice = config?.type === 'FIXED_AMOUNT' ? dto.price + config.value : dto.price;

    return this.prisma.product.create({
      data: { ...dto, professionalId: prof.id, price: displayPrice, name: dto.name, description: dto.description },
    });
  }

  async updateProduct(userId: string, productId: string, dto: UpdateProductDto) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, include: { professional: true } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.professional.userId !== userId) throw new ForbiddenException();
    return this.prisma.product.update({ where: { id: productId }, data: dto });
  }

  async deleteProduct(userId: string, productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, include: { professional: true } });
    if (!product) throw new NotFoundException();
    if (product.professional.userId !== userId) throw new ForbiddenException();
    return this.prisma.product.delete({ where: { id: productId } });
  }

  async toggleAvailability(userId: string, productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, include: { professional: true } });
    if (!product) throw new NotFoundException();
    if (product.professional.userId !== userId) throw new ForbiddenException();
    return this.prisma.product.update({ where: { id: productId }, data: { isAvailable: !product.isAvailable } });
  }

  /**
   * Upload une image produit (multipart) vers Cloudinary et persiste l'URL.
   * - Vérifie que le produit appartient bien au pro authentifié.
   * - Délégué à UploadsService.uploadFile() qui valide mime (jpg/png/webp)
   *   et taille (max 10 Mo) côté infra.
   * - Réponse compatible avec le mobile : `{ data: { imageUrl } }`
   *   (le mobile lit `data.imageUrl ?? data.url`).
   */
  async uploadImage(userId: string, productId: string, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Aucune image fournie');

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { professional: true },
    });
    if (!product) throw new NotFoundException('Produit introuvable');
    if (product.professional.userId !== userId) {
      throw new ForbiddenException("Ce produit ne vous appartient pas");
    }

    // Upload vers Cloudinary, folder dédié pour faciliter la purge/quota.
    const imageUrl = await this.uploads.uploadFile(file, 'ife-food/products');

    // Persiste l'URL sur le produit. Pas de soft-delete de l'ancienne image —
    // Cloudinary la conservera (purge à programmer côté admin si besoin).
    await this.prisma.product.update({
      where: { id: productId },
      data: { imageUrl },
    });

    return { imageUrl };
  }

  async getProducts(professionalId: string, pagination: PaginationDto) {
    const [products, total] = await Promise.all([
      this.prisma.product.findMany({ where: { professionalId }, include: { category: true }, skip: pagination.skip, take: pagination.limit }),
      this.prisma.product.count({ where: { professionalId } }),
    ]);
    return { data: products, meta: { total, page: pagination.page, limit: pagination.limit } };
  }

  async searchProducts(query: string, lat?: number, lng?: number) {
    const products = await this.prisma.product.findMany({
      where: {
        isAvailable: true,
        professional: { status: 'VALIDATED', isOpen: true },
        OR: [
          { name: { path: ['fr'], string_contains: query } },
          { name: { path: ['en'], string_contains: query } },
        ],
      },
      include: { professional: { select: { id: true, businessName: true, lat: true, lng: true, logoUrl: true } } },
      take: 20,
    });
    return { data: products };
  }
}
