import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateProductDto, UpdateProductDto, CreateCategoryDto, UpdateCategoryDto, ReorderCategoriesDto, GetProductsQueryDto } from './dto/product.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private uploads: UploadsService,
  ) {}

  async createCategory(dto: CreateCategoryDto) {
    return this.prisma.productCategory.create({ data: { name: dto.name, icon: dto.icon } });
  }

  // Catalogue client : retourne les catégories qui ont au moins un produit
  // disponible chez ce professionnel, avec leurs produits filtrés.
  async getCategories(professionalId: string) {
    const [categories, cfgRow] = await Promise.all([
      this.prisma.productCategory.findMany({
        where: { products: { some: { professionalId, isAvailable: true } } },
        orderBy: { sortOrder: 'asc' },
        include: { products: { where: { professionalId, isAvailable: true } } },
      }),
      this.prisma.platformConfig.findUnique({ where: { key: 'commission' } }),
    ]);

    const cfg = cfgRow?.value as any;
    const proCfg = cfg?.professional ?? cfg;
    const isFixedPerDish = proCfg?.type === 'FIXED_PER_DISH' || proCfg?.type === 'FIXED_AMOUNT';
    const fixedPerDish = isFixedPerDish ? Number(proCfg.value ?? 0) : 0;

    if (fixedPerDish === 0) return categories;
    return categories.map((cat: any) => ({
      ...cat,
      products: cat.products.map((p: any) => ({ ...p, price: p.price + fixedPerDish })),
    }));
  }

  // Toutes les catégories globales — pour le sélecteur lors de la création de produit.
  async getAllCategories() {
    return this.prisma.productCategory.findMany({
      select: { id: true, name: true, icon: true, sortOrder: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  // ── Catégories : update + delete + reorder ─────────────────────────────────

  async updateCategory(categoryId: string, dto: UpdateCategoryDto) {
    const cat = await this.prisma.productCategory.findUnique({ where: { id: categoryId } });
    if (!cat) throw new NotFoundException('Catégorie introuvable');
    return this.prisma.productCategory.update({ where: { id: categoryId }, data: dto });
  }

  async deleteCategory(categoryId: string) {
    const cat = await this.prisma.productCategory.findUnique({ where: { id: categoryId } });
    if (!cat) throw new NotFoundException('Catégorie introuvable');
    await this.prisma.$transaction([
      this.prisma.product.updateMany({ where: { categoryId }, data: { categoryId: null } }),
      this.prisma.productCategory.delete({ where: { id: categoryId } }),
    ]);
    return { ok: true };
  }

  async reorderCategories(dto: ReorderCategoriesDto) {
    if (!dto.items?.length) return { updated: 0 };
    await this.prisma.$transaction(
      dto.items.map((i) => this.prisma.productCategory.update({
        where: { id: i.id },
        data:  { sortOrder: i.sortOrder },
      })),
    );
    return { updated: dto.items.length };
  }

  async createProduct(userId: string, dto: CreateProductDto) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException('Professional profile not found');
    // Always store base price; commission is applied at read time (getCategories)
    return this.prisma.product.create({
      data: { ...dto, professionalId: prof.id },
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

    const imageUrl = await this.uploads.uploadFile(file, 'ife-food/products');

    // Persiste la nouvelle URL. L'ancienne image reste sur disque —
    // nettoyage à planifier côté admin si besoin.
    await this.prisma.product.update({
      where: { id: productId },
      data: { imageUrl },
    });

    return { imageUrl };
  }

  async getCategoriesMine(userId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException('Professional profile not found');
    return this.getCategories(prof.id);
  }

  async getCategoriesForPro(_userId: string) {
    return this.getAllCategories();
  }

  async getProductsMine(userId: string, pagination: PaginationDto) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException('Professional profile not found');
    return this.getProducts(prof.id, pagination);
  }

  async getProducts(professionalId: string, pagination: PaginationDto | GetProductsQueryDto) {
    const isAvailable = (pagination as GetProductsQueryDto).isAvailable;
    const where: any = { professionalId };
    if (isAvailable !== undefined) where.isAvailable = isAvailable;
    const [products, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: { category: true }, skip: pagination.skip, take: pagination.limit }),
      this.prisma.product.count({ where }),
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
