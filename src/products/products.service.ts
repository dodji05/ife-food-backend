import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateProductDto, UpdateProductDto, CreateCategoryDto, UpdateCategoryDto, ReorderCategoriesDto } from './dto/product.dto';
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
    const [categories, cfgRow] = await Promise.all([
      this.prisma.productCategory.findMany({
        where: { professionalId },
        orderBy: { sortOrder: 'asc' },
        include: { products: { where: { isAvailable: true } } },
      }),
      this.prisma.platformConfig.findUnique({ where: { key: 'commission' } }),
    ]);

    const cfg = cfgRow?.value as any;
    // Support new format { professional: {type, value} } and legacy { type, value }
    const proCfg = cfg?.professional ?? cfg;
    const isFixedPerDish = proCfg?.type === 'FIXED_PER_DISH' || proCfg?.type === 'FIXED_AMOUNT';
    const fixedPerDish = isFixedPerDish ? Number(proCfg.value ?? 0) : 0;

    if (fixedPerDish === 0) return categories;

    // Inflate product prices transparently for client-facing display
    return categories.map((cat: any) => ({
      ...cat,
      products: cat.products.map((p: any) => ({ ...p, price: p.price + fixedPerDish })),
    }));
  }

  // ── Catégories : update + delete + reorder ─────────────────────────────────
  // Toutes les mutations vérifient l'ownership (la catégorie doit appartenir
  // au pro authentifié) pour éviter qu'un user manipule les catégories d'autrui.

  async updateCategory(userId: string, categoryId: string, dto: UpdateCategoryDto) {
    const cat = await this.prisma.productCategory.findUnique({
      where: { id: categoryId },
      include: { professional: true },
    });
    if (!cat) throw new NotFoundException('Catégorie introuvable');
    if (cat.professional.userId !== userId) throw new ForbiddenException();
    return this.prisma.productCategory.update({ where: { id: categoryId }, data: dto });
  }

  async deleteCategory(userId: string, categoryId: string) {
    const cat = await this.prisma.productCategory.findUnique({
      where: { id: categoryId },
      include: { professional: true },
    });
    if (!cat) throw new NotFoundException('Catégorie introuvable');
    if (cat.professional.userId !== userId) throw new ForbiddenException();
    // Avant delete : on détache tous les produits qui référencent cette
    // catégorie (categoryId -> null). Sinon Prisma rejetterait à cause de
    // la FK. UX : le produit n'est pas supprimé, juste 'décategorisé'.
    await this.prisma.$transaction([
      this.prisma.product.updateMany({
        where: { categoryId },
        data:  { categoryId: null },
      }),
      this.prisma.productCategory.delete({ where: { id: categoryId } }),
    ]);
    return { ok: true };
  }

  async reorderCategories(userId: string, dto: ReorderCategoriesDto) {
    // Récupère toutes les catégories du pro pour vérifier ownership avant
    // d'appliquer les updates. Évite qu'un user puisse réordonner les
    // catégories d'un autre pro en glissant des ids étrangers.
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException('Profile not found');
    const owned = await this.prisma.productCategory.findMany({
      where: { professionalId: prof.id }, select: { id: true },
    });
    const ownedIds = new Set(owned.map((c) => c.id));
    const safeItems = dto.items.filter((i) => ownedIds.has(i.id));

    if (safeItems.length === 0) return { updated: 0 };

    // Transaction : tous les sortOrder en une seule fois. Si l'un échoue,
    // aucun n'est appliqué (cohérence).
    await this.prisma.$transaction(
      safeItems.map((i) => this.prisma.productCategory.update({
        where: { id: i.id },
        data:  { sortOrder: i.sortOrder },
      })),
    );
    return { updated: safeItems.length };
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
