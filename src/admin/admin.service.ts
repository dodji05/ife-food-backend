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
    if (period && !Object.keys(periodMap).includes(period)) period = 'week';
    const since = periodMap[period] ?? periodMap.week;

    const [orders, revenue, newUsers, newProfessionals, newDrivers, activeDeliveries, avgRating, cancelRate, recentOrders] = await Promise.all([
      this.prisma.order.aggregate({ where: { createdAt: { gte: since } }, _count: true, _sum: { totalAmount: true } }),
      this.prisma.transaction.aggregate({ where: { type: 'COMMISSION', createdAt: { gte: since } }, _sum: { amount: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: since }, role: 'CLIENT' } }),
      this.prisma.professional.count({ where: { createdAt: { gte: since } } }),
      this.prisma.driver.count({ where: { createdAt: { gte: since } } }),
      this.prisma.delivery.count({ where: { status: { in: ['IN_DELIVERY', 'ASSIGNED'] as any } } }),
      this.prisma.review.aggregate({ _avg: { professionalRating: true } }),
      this.prisma.order.count({ where: { status: 'CANCELLED' as any, createdAt: { gte: since } } }),
      this.prisma.order.findMany({
        where: { createdAt: { gte: since }, status: 'DELIVERED' as any },
        select: { createdAt: true, totalAmount: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Build daily chart data grouped by day label
    const dayLabels = period === 'month'
      ? Array.from({ length: 30 }, (_, i) => { const d = new Date(since); d.setDate(d.getDate() + i); return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }); })
      : ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

    const chartMap = new Map<string, { revenue: number; orders: number }>();
    for (const label of dayLabels) chartMap.set(label, { revenue: 0, orders: 0 });

    for (const order of recentOrders) {
      const label = period === 'month'
        ? new Date(order.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
        : ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][new Date(order.createdAt).getDay()];
      const entry = chartMap.get(label);
      if (entry) { entry.revenue += order.totalAmount; entry.orders += 1; }
    }

    const chartData = dayLabels.map(day => ({ day, ...chartMap.get(day) }));
    const cancelRatePercent = orders._count > 0 ? (cancelRate / orders._count * 100).toFixed(1) : 0;

    return {
      data: {
        orders: { count: orders._count, revenue: orders._sum.totalAmount ?? 0 },
        commissions: revenue._sum.amount ?? 0,
        newUsers, newProfessionals, newDrivers, activeDeliveries,
        avgRating: avgRating._avg.professionalRating,
        cancelRate: cancelRatePercent,
        chartData,
      },
    };
  }

  // ─── PROFESSIONALS VALIDATION ─────────────
  async getPendingProfessionals() {
    const data = await this.prisma.professional.findMany({
      where: { status: 'PENDING' },
      include: { user: { select: { name: true, phone: true, email: true } }, documents: true },
      orderBy: { createdAt: 'asc' },
    });
    return { data };
  }

  async getAllProfessionals(pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.professional.findMany({
        include: { user: { select: { name: true, firstName: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.professional.count(),
    ]);
    return { data, meta: { total } };
  }

  async getPendingDrivers() {
    const data = await this.prisma.driver.findMany({
      where: { status: 'PENDING' },
      include: { user: { select: { name: true, firstName: true, phone: true, avatarUrl: true } }, documents: true },
      orderBy: { createdAt: 'asc' },
    });
    return { data };
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
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination?.skip,
        take: pagination?.limit,
        select: {
          id: true, phone: true, phoneCountry: true, name: true, firstName: true,
          email: true, avatarUrl: true, role: true, status: true, lang: true,
          countryCode: true, currency: true, biometricEnabled: true,
          twoFaEnabled: true, lastLoginAt: true, createdAt: true, updatedAt: true,
        },
      }),
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
    if (filters.status) {
      const statuses = String(filters.status).split(',').map((s: string) => s.trim()).filter(Boolean);
      where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
    }
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
  // FIX: Ajout du GET manquant pour que le frontend puisse charger la commission courante
  async getCommissionConfig() {
    const row = await this.prisma.platformConfig.findUnique({ where: { key: 'commission' } });
    const defaultConfig = { type: 'PERCENTAGE', value: 15, perCategory: null };
    return { data: row ? (row.value as any) : defaultConfig };
  }

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

  // FIX: Ajout du endpoint manquant — badge de notifications non lues dans le header admin
  async getAdminNotificationsCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });
    return { data: { count } };
  }

  // ─── PLATFORM CONFIG ─────────────────────
  async getPlatformConfig() {
    const keys = ['otpChannel', 'cancelDelay', 'missionDelay', 'maintenanceMode'];
    const rows = await this.prisma.platformConfig.findMany({ where: { key: { in: keys } } });
    const result: any = { otpChannel: 'SMS', cancelDelay: 5, missionDelay: 30, maintenanceMode: false };
    for (const row of rows) result[row.key] = row.value;
    return { data: result };
  }

  async setPlatformConfig(config: { otpChannel?: string; cancelDelay?: number; missionDelay?: number; maintenanceMode?: boolean }) {
    const entries = Object.entries(config).filter(([, v]) => v !== undefined);
    await Promise.all(entries.map(([key, value]) =>
      this.prisma.platformConfig.upsert({
        where: { key },
        update: { value: value as any },
        create: { key, value: value as any },
      })
    ));
    return { success: true };
  }

  // ─── CATALOGUE (admin) ────────────────────
  async getAllProducts(pagination: PaginationDto) {
    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        include: {
          professional: { select: { businessName: true, city: true } },
          category: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.product.count(),
    ]);
    return { data: products, meta: { total } };
  }

  // ─── PAYMENT STATS ────────────────────────
  async getPaymentStats() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [monthlyRevenue, monthlyCommissions, pendingPayouts, totalTransactions] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { type: 'PAYOUT', status: 'COMPLETED', createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { type: 'COMMISSION', status: 'COMPLETED', createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.count({ where: { type: 'PAYOUT', status: 'PENDING' } }),
      this.prisma.transaction.count(),
    ]);

    return {
      data: {
        monthlyRevenue: monthlyRevenue._sum.amount ?? 0,
        monthlyCommissions: monthlyCommissions._sum.amount ?? 0,
        pendingPayouts,
        totalTransactions,
      },
    };
  }

  // ─── ANALYTICS ────────────────────────────
  async getAnalytics() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalOrders, completedOrders, avgBasket, avgDelivery, byCategory, totalUsers, repeatUsers] = await Promise.all([
      this.prisma.order.count({ where: { createdAt: { gte: startOfMonth } } }),
      this.prisma.order.count({ where: { status: 'DELIVERED', createdAt: { gte: startOfMonth } } }),
      this.prisma.order.aggregate({ _avg: { subtotal: true }, where: { status: 'DELIVERED', createdAt: { gte: startOfMonth } } }),
      this.prisma.delivery.aggregate({ _avg: { distanceKm: true }, where: { status: 'DELIVERED', createdAt: { gte: startOfMonth } } }),
      this.prisma.professional.groupBy({ by: ['category'], _count: { id: true } }),
      this.prisma.user.count({ where: { role: 'CLIENT' } }),
      this.prisma.order.groupBy({ by: ['clientId'], having: { clientId: { _count: { gte: 3 } } }, _count: { clientId: true } }),
    ]);

    const completionRate = totalOrders > 0 ? Number((completedOrders / totalOrders * 100).toFixed(1)) : 0;

    const categoryMap: Record<string, string> = {
      RESTAURANT: 'Restaurants', GROCERY: 'Épiceries', SUPERMARKET: 'Supermarchés',
      BAKERY: 'Boulangeries', PHARMACY: 'Pharmacies', OTHER: 'Autres',
    };
    const totalCatCount = byCategory.reduce((s, c) => s + c._count.id, 0) || 1;

    return {
      data: {
        completionRate,
        avgBasket: Math.round(avgBasket._avg.subtotal ?? 0),
        avgDeliveryMin: Math.round((avgDelivery._avg.distanceKm ?? 5) * 4),
        retentionRate: totalUsers > 0 ? Number((repeatUsers.length / totalUsers * 100).toFixed(1)) : 0,
        byCategory: byCategory.map(c => ({
          name: categoryMap[c.category] ?? c.category,
          value: Math.round(c._count.id / totalCatCount * 100),
        })),
        byCountry: [],
        funnel: [],
      },
    };
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
