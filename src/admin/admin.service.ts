import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  // ─── DASHBOARD ────────────────────────────
  async getDashboard(period: string = 'week') {
    const now = new Date();
    const periodMap: Record<string, Date> = {
      day: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      month: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    };
    const since = periodMap[period] ?? periodMap.week;

    const [orders, revenue, newUsers, newProfessionals, newDrivers, activeDeliveries, avgRating, cancelRate] = await Promise.all([
      this.prisma.order.aggregate({ where: { createdAt: { gte: since } }, _count: true, _sum: { totalAmount: true } }),
      this.prisma.transaction.aggregate({ where: { type: 'COMMISSION', createdAt: { gte: since } }, _sum: { amount: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: since }, role: 'CLIENT' } }),
      this.prisma.professional.count({ where: { createdAt: { gte: since } } }),
      this.prisma.driver.count({ where: { createdAt: { gte: since } } }),
      this.prisma.delivery.count({ where: { status: { in: ['IN_DELIVERY','ASSIGNED'] } } }),
      this.prisma.review.aggregate({ _avg: { professionalRating: true } }),
      this.prisma.order.count({ where: { status: 'CANCELLED', createdAt: { gte: since } } }),
    ]);

    const cancelRatePercent = orders._count > 0 ? (cancelRate / orders._count * 100).toFixed(1) : 0;

    return {
      data: {
        orders: { count: orders._count, revenue: orders._sum.totalAmount ?? 0 },
        commissions: revenue._sum.amount ?? 0,
        newUsers, newProfessionals, newDrivers, activeDeliveries,
        avgRating: avgRating._avg.professionalRating,
        cancelRate: cancelRatePercent,
      },
    };
  }

  // ─── PROFESSIONALS VALIDATION ─────────────
  async getPendingProfessionals() {
    return this.prisma.professional.findMany({
      where: { status: 'PENDING' },
      include: { user: { select: { name: true, phone: true, email: true } }, documents: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async validateProfessional(id: string, status: 'VALIDATED' | 'REJECTED', note?: string) {
    const prof = await this.prisma.professional.findUnique({ where: { id }, include: { user: true } });
    if (!prof) throw new NotFoundException();

    await this.prisma.professional.update({ where: { id }, data: { status, adminNote: note, validatedAt: status === 'VALIDATED' ? new Date() : null } });
    await this.prisma.user.update({ where: { id: prof.userId }, data: { status: status === 'VALIDATED' ? 'ACTIVE' : 'SUSPENDED' } });

    await this.notifications.sendPush(prof.userId,
      status === 'VALIDATED' ? '🎉 Compte validé !' : 'Compte non validé',
      status === 'VALIDATED' ? 'Votre établissement est maintenant actif sur ifè FOOD.' : `Votre inscription a été refusée${note ? `: ${note}` : '.'}`
    );
    return { success: true };
  }

  async validateDriver(id: string, status: 'VALIDATED' | 'REJECTED', note?: string) {
    const driver = await this.prisma.driver.findUnique({ where: { id }, include: { user: true } });
    if (!driver) throw new NotFoundException();

    await this.prisma.driver.update({ where: { id }, data: { status: status as any, adminNote: note, validatedAt: status === 'VALIDATED' ? new Date() : null } });
    await this.prisma.user.update({ where: { id: driver.userId }, data: { status: status === 'VALIDATED' ? 'ACTIVE' : 'SUSPENDED' } });

    await this.notifications.sendPush(driver.userId,
      status === 'VALIDATED' ? '🚀 Compte livreur validé !' : 'Compte non validé',
      status === 'VALIDATED' ? 'Vous pouvez maintenant recevoir des missions de livraison.' : `Votre inscription a été refusée${note ? `: ${note}` : '.'}`
    );
    return { success: true };
  }

  // ─── USERS MANAGEMENT ─────────────────────
  async getUsers(role?: string, pagination?: PaginationDto) {
    const where: any = {};
    if (role) where.role = role;
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: pagination?.skip, take: pagination?.limit }),
      this.prisma.user.count({ where }),
    ]);
    return { data: users, meta: { total } };
  }

  async updateUserStatus(id: string, status: string) {
    return this.prisma.user.update({ where: { id }, data: { status: status as any } });
  }

  // ─── ORDERS MANAGEMENT ────────────────────
  async getAllOrders(filters: any, pagination: PaginationDto) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.country) where.deliveryCountry = filters.country;
    if (filters.from && filters.to) where.createdAt = { gte: new Date(filters.from), lte: new Date(filters.to) };

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          client: { select: { name: true, phone: true } },
          professional: { select: { businessName: true } },
          driver: { include: { user: { select: { name: true } } } },
          payment: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip, take: pagination.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data: orders, meta: { total, page: pagination.page, limit: pagination.limit } };
  }

  async reassignDriver(orderId: string, driverId: string) {
    await this.prisma.order.update({ where: { id: orderId }, data: { driverId } });
    await this.prisma.delivery.updateMany({ where: { orderId }, data: { driverId } });
    return { success: true };
  }

  // ─── COMMISSION CONFIG ────────────────────
  async setCommissionConfig(type: 'PERCENTAGE' | 'FIXED_AMOUNT', value: number, perCategory?: Record<string, number>) {
    return this.prisma.platformConfig.upsert({
      where: { key: 'commission' },
      update: { value: { type, value, perCategory } },
      create: { key: 'commission', value: { type, value, perCategory } },
    });
  }

  async setPaymentGateways(config: Record<string, boolean>) {
    return this.prisma.platformConfig.upsert({
      where: { key: 'paymentGateways' },
      update: { value: config },
      create: { key: 'paymentGateways', value: config },
    });
  }

  // ─── PROMO CODES ──────────────────────────
  async createPromoCode(dto: any) {
    return this.prisma.promoCode.create({ data: dto });
  }

  async getPromoCodes() {
    return this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
  }

  // ─── LEGAL PAGES ──────────────────────────
  async getLegalPage(type: string, lang: string) {
    return this.prisma.legalPage.findUnique({ where: { type_lang: { type, lang: lang as any } } });
  }

  async upsertLegalPage(type: string, lang: string, title: string, content: string, version: string) {
    return this.prisma.legalPage.upsert({
      where: { type_lang: { type, lang: lang as any } },
      update: { title, content, version },
      create: { type, lang: lang as any, title, content, version },
    });
  }

  // ─── BANNERS ──────────────────────────────
  async getBanners() {
    return this.prisma.banner.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  }

  async createBanner(dto: any) {
    return this.prisma.banner.create({ data: dto });
  }

  async updateBanner(id: string, dto: any) {
    return this.prisma.banner.update({ where: { id }, data: dto });
  }

  async deleteBanner(id: string) {
    return this.prisma.banner.delete({ where: { id } });
  }

  // ─── DELIVERY ZONES ───────────────────────
  async getDeliveryZones() {
    return this.prisma.deliveryZone.findMany();
  }

  async upsertDeliveryZone(dto: any) {
    if (dto.id) return this.prisma.deliveryZone.update({ where: { id: dto.id }, data: dto });
    return this.prisma.deliveryZone.create({ data: dto });
  }

  // ─── PUSH BROADCAST ───────────────────────
  async broadcastNotification(title: string, body: string, role?: string, countries?: string[]) {
    return this.notifications.sendToAllUsers(title, body, role, countries);
  }

  // ─── FINANCES ────────────────────────────
  async getFinancialReport(from: string, to: string) {
    const where = { createdAt: { gte: new Date(from), lte: new Date(to) } };
    const [total, commissions, payouts, refunds] = await Promise.all([
      this.prisma.transaction.aggregate({ where, _sum: { amount: true } }),
      this.prisma.transaction.aggregate({ where: { ...where, type: 'COMMISSION' }, _sum: { amount: true } }),
      this.prisma.transaction.aggregate({ where: { ...where, type: 'PAYOUT' }, _sum: { amount: true } }),
      this.prisma.transaction.aggregate({ where: { ...where, type: 'REFUND' }, _sum: { amount: true } }),
    ]);
    return { data: { total: total._sum.amount, commissions: commissions._sum.amount, payouts: payouts._sum.amount, refunds: refunds._sum.amount } };
  }
}
