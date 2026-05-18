import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProfessionalDto, UpdateProfessionalDto, UpdateOpeningHoursDto } from './dto/professional.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class ProfessionalsService {
  constructor(private prisma: PrismaService) {}

  async register(userId: string, dto: CreateProfessionalDto) {
    const existing = await this.prisma.professional.findUnique({ where: { userId } });
    if (existing) throw new ConflictException('Professional profile already exists');

    return this.prisma.professional.create({
      data: { ...dto, userId, category: dto.category as any, status: 'PENDING' },
    });
  }

  async getMyProfile(userId: string) {
    const prof = await this.prisma.professional.findUnique({
      where: { userId },
      include: { documents: true },
    });
    if (!prof) throw new NotFoundException('Professional profile not found');
    return { data: prof };
  }

  async updateProfile(userId: string, dto: UpdateProfessionalDto) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException('Profile not found');
    return this.prisma.professional.update({ where: { userId }, data: dto });
  }

  async toggleOpen(userId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    return this.prisma.professional.update({ where: { userId }, data: { isOpen: !prof.isOpen } });
  }

  async updateOpeningHours(userId: string, dto: UpdateOpeningHoursDto) {
    return this.prisma.professional.update({ where: { userId }, data: { openingHours: dto.openingHours } });
  }

  async getPublicProfile(id: string) {
    const prof = await this.prisma.professional.findUnique({
      where: { id, status: 'VALIDATED' },
      include: {
        products: { where: { isAvailable: true }, include: { category: true } },
        reviews: {
          include: { reviewer: { select: { name: true, avatarUrl: true } } },
          take: 10,
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { reviews: true } },
      },
    });
    if (!prof) throw new NotFoundException('Establishment not found');

    // Note moyenne sur l'ensemble des reviews (pas seulement les 10 dernières).
    const ratingAgg = await this.prisma.review.aggregate({
      where: { professionalId: id },
      _avg: { professionalRating: true },
    });
    const avgRating = ratingAgg._avg.professionalRating ?? 0;

    // Délai de livraison moyen depuis la config plateforme, sinon valeur par défaut.
    const deliveryConfig = await this.prisma.platformConfig.findUnique({ where: { key: 'delivery' } });
    const deliveryDefaults = (deliveryConfig?.value as any) ?? {};

    return {
      data: {
        ...prof,
        // Champs aplatis pour le mobile
        avgRating: Math.round(avgRating * 10) / 10,
        reviewCount: prof._count.reviews,
        deliveryTimeMin: deliveryDefaults.defaultTimeMin ?? 25,
        deliveryFee: deliveryDefaults.defaultFee ?? 0,
      },
    };
  }

  async getFavoriteDrivers(userId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    return this.prisma.professionalFavoriteDriver.findMany({
      where: { professionalId: prof.id },
      include: { driver: { include: { user: { select: { name: true, firstName: true, avatarUrl: true, phone: true } } } } },
    });
  }

  async addFavoriteDriver(userId: string, driverId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    return this.prisma.professionalFavoriteDriver.upsert({
      where: { professionalId_driverId: { professionalId: prof.id, driverId } },
      update: {},
      create: { professionalId: prof.id, driverId },
    });
  }

  async removeFavoriteDriver(userId: string, driverId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    return this.prisma.professionalFavoriteDriver.delete({
      where: { professionalId_driverId: { professionalId: prof.id, driverId } },
    });
  }

  async getDashboard(userId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();

    const today = new Date(); today.setHours(0,0,0,0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // ── 7-day revenue series : 7 aggregates parallèles ─────────────────────
    // Format de sortie : [{date: 'YYYY-MM-DD', revenue: 12500, orders: 3}, …]
    // Indexé oldest → newest pour permettre au mobile de tracer un LineChart
    // gauche → droite sans tri.
    const days: Date[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      days.push(d);
    }
    const dayAggregates = await Promise.all(
      days.map((dayStart) => {
        const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
        return this.prisma.order.aggregate({
          where: {
            professionalId: prof.id,
            status: 'DELIVERED',
            createdAt: { gte: dayStart, lt: dayEnd },
          },
          _sum: { totalAmount: true },
          _count: true,
        });
      }),
    );
    const revenueByDay = days.map((d, i) => ({
      date: d.toISOString().substring(0, 10), // YYYY-MM-DD
      revenue: dayAggregates[i]._sum.totalAmount ?? 0,
      orders: dayAggregates[i]._count,
    }));

    const [
      todayOrders, weekOrders, monthOrders, pending,
      totalOrders, ratingAgg, topProductsAgg, recentReviews,
    ] = await Promise.all([
      this.prisma.order.aggregate({ where: { professionalId: prof.id, createdAt: { gte: today }, status: 'DELIVERED' }, _sum: { totalAmount: true }, _count: true }),
      this.prisma.order.aggregate({ where: { professionalId: prof.id, createdAt: { gte: weekAgo }, status: 'DELIVERED' }, _sum: { totalAmount: true } }),
      this.prisma.order.aggregate({ where: { professionalId: prof.id, createdAt: { gte: monthAgo }, status: 'DELIVERED' }, _sum: { totalAmount: true } }),
      this.prisma.order.count({ where: { professionalId: prof.id, status: { in: ['PAID','ACCEPTED','IN_PREPARATION'] } } }),
      this.prisma.order.count({ where: { professionalId: prof.id, status: 'DELIVERED' } }),
      // Le schéma Review a deux colonnes : professionalRating (note pour le
      // restaurant) et driverRating (note pour le livreur). Côté dashboard
      // pro, seule professionalRating est pertinente.
      this.prisma.review.aggregate({ where: { professionalId: prof.id }, _avg: { professionalRating: true }, _count: true }),
      this.prisma.orderItem.groupBy({ by: ['productId'], where: { order: { professionalId: prof.id, status: 'DELIVERED' } }, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: 5 }),
      this.prisma.review.findMany({ where: { professionalId: prof.id }, orderBy: { createdAt: 'desc' }, take: 5, include: { reviewer: { select: { name: true, avatarUrl: true } } } }),
    ]);

    // Enrichir topProducts avec les infos produit (nom multilingue + image)
    // pour que le mobile puisse afficher la liste sans appel additionnel.
    const productIds = topProductsAgg.map((t) => t.productId);
    const products = productIds.length > 0
      ? await this.prisma.product.findMany({ where: { id: { in: productIds } } })
      : [];
    const productMap = new Map(products.map((p) => [p.id, p]));
    const topProducts = topProductsAgg.map((t) => ({
      productId: t.productId,
      quantitySold: t._sum.quantity ?? 0,
      product: productMap.get(t.productId) ?? null,
    }));

    return {
      data: {
        revenue: {
          today: todayOrders._sum.totalAmount ?? 0,
          week: weekOrders._sum.totalAmount ?? 0,
          month: monthOrders._sum.totalAmount ?? 0,
        },
        orders: {
          today: todayOrders._count,
          pending,
          total: totalOrders,
        },
        // Note moyenne arrondie 1 décimale + nb d'avis (utile pour le badge).
        avgRating: ratingAgg._avg.professionalRating
            ? Number(ratingAgg._avg.professionalRating.toFixed(1))
            : 0,
        reviewCount: ratingAgg._count,
        revenueByDay,
        topProducts,
        recentReviews,
      },
    };
  }
}
