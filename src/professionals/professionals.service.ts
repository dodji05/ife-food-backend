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
        reviews: { include: { reviewer: { select: { name: true, avatarUrl: true } } }, take: 10, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!prof) throw new NotFoundException('Establishment not found');
    const avgRating = prof.reviews.length ? prof.reviews.reduce((s, r) => s + (r.professionalRating ?? 0), 0) / prof.reviews.length : 0;
    return { data: { ...prof, avgRating: Math.round(avgRating * 10) / 10 } };
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

    const [todayOrders, weekOrders, monthOrders, pending, topProducts, recentReviews] = await Promise.all([
      this.prisma.order.aggregate({ where: { professionalId: prof.id, createdAt: { gte: today }, status: 'DELIVERED' }, _sum: { totalAmount: true }, _count: true }),
      this.prisma.order.aggregate({ where: { professionalId: prof.id, createdAt: { gte: weekAgo }, status: 'DELIVERED' }, _sum: { totalAmount: true } }),
      this.prisma.order.aggregate({ where: { professionalId: prof.id, createdAt: { gte: monthAgo }, status: 'DELIVERED' }, _sum: { totalAmount: true } }),
      this.prisma.order.count({ where: { professionalId: prof.id, status: { in: ['PAID','ACCEPTED','IN_PREPARATION'] } } }),
      this.prisma.orderItem.groupBy({ by: ['productId'], where: { order: { professionalId: prof.id, status: 'DELIVERED' } }, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: 5 }),
      this.prisma.review.findMany({ where: { professionalId: prof.id }, orderBy: { createdAt: 'desc' }, take: 5, include: { reviewer: { select: { name: true, avatarUrl: true } } } }),
    ]);

    return {
      data: {
        revenue: { today: todayOrders._sum.totalAmount ?? 0, week: weekOrders._sum.totalAmount ?? 0, month: monthOrders._sum.totalAmount ?? 0 },
        orders: { today: todayOrders._count, pending },
        topProducts,
        recentReviews,
      },
    };
  }
}
