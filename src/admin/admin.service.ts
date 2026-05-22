import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  // ─── DASHBOARD ────────────────────────────
  async getDashboard(period: string = 'week', country?: string, city?: string) {
    const now = new Date();
    const periodMap: Record<string, Date> = {
      day: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      month: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    };
    const since = periodMap[period] ?? periodMap.week;
    const geoFilter = country ? { deliveryCountry: country } : {};
    const cityFilter = city ? { deliveryCity: city } : {};
    const baseWhere = { createdAt: { gte: since }, ...geoFilter, ...cityFilter };

    // Statuses en cours = entre PAID et IN_DELIVERY exclus
    const inProgressStatuses = ['ACCEPTED', 'IN_PREPARATION', 'READY_FOR_PICKUP', 'DRIVER_ASSIGNED', 'PICKED_UP', 'IN_DELIVERY'] as const;

    const [
      orders, revenue, newUsers, newProfessionals, newDrivers, activeDeliveries,
      avgRating, cancelRate, rawOrders,
      // ─── Nouveaux compteurs par statut ───
      ordersToValidate, ordersInPreparation, ordersDelivered, ordersCancelled,
      // ─── Nouveau bloc finance ─────────────
      financeAgg, tipsAgg,
      // ─── Livreurs actifs (qui ont livré sur la période) ───
      activeDriversIds,
      // ─── Répartition utilisateurs (pour le pie) ───
      usersClientCount, usersProCount, usersDriverCount,
      // ─── Top 5 ────────────────────────────
      topCountriesRaw, topClientsRaw, topDriversRaw, topProsRaw,
      // ─── Liste des villes distinctes (pour le dropdown filtre) ───
      distinctCitiesRaw,
    ] = await Promise.all([
      this.prisma.order.aggregate({ where: baseWhere, _count: true, _sum: { totalAmount: true } }),
      this.prisma.transaction.aggregate({ where: { type: 'COMMISSION', createdAt: { gte: since } }, _sum: { amount: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: since }, role: 'CLIENT', ...(country ? { countryCode: country } : {}) } }),
      this.prisma.professional.count({ where: { createdAt: { gte: since } } }),
      this.prisma.driver.count({ where: { createdAt: { gte: since } } }),
      this.prisma.delivery.count({ where: { status: { in: ['IN_DELIVERY','ASSIGNED'] } } }),
      this.prisma.review.aggregate({ _avg: { professionalRating: true } }),
      this.prisma.order.count({ where: { ...baseWhere, status: 'CANCELLED' } }),
      this.prisma.order.findMany({ where: baseWhere, select: { createdAt: true, totalAmount: true } }),
      // Compteurs par statut
      this.prisma.order.count({ where: { ...baseWhere, status: 'PAID' } }),
      this.prisma.order.count({ where: { ...baseWhere, status: { in: inProgressStatuses as any } } }),
      this.prisma.order.count({ where: { ...baseWhere, status: 'DELIVERED' } }),
      this.prisma.order.count({ where: { ...baseWhere, status: 'CANCELLED' } }),
      // Finance — agrégats sur DELIVERED uniquement (revenu réel)
      this.prisma.order.aggregate({
        where: { ...baseWhere, status: 'DELIVERED' },
        _sum: { totalAmount: true, deliveryFee: true, commissionAmount: true, subtotal: true },
      }),
      // Pourboires livreurs
      this.prisma.transaction.aggregate({
        where: { type: 'TIP', createdAt: { gte: since }, ...(country ? { driver: { user: { countryCode: country } } } : {}) },
        _sum: { amount: true },
      }),
      // Livreurs distincts qui ont effectué au moins une livraison sur la période
      this.prisma.delivery.groupBy({
        by: ['driverId'],
        where: { status: 'DELIVERED', createdAt: { gte: since } },
      }),
      // User counts par rôle (pour pie chart)
      this.prisma.user.count({ where: { role: 'CLIENT', ...(country ? { countryCode: country } : {}) } }),
      this.prisma.user.count({ where: { role: 'PROFESSIONAL', ...(country ? { countryCode: country } : {}) } }),
      this.prisma.user.count({ where: { role: 'DRIVER', ...(country ? { countryCode: country } : {}) } }),
      // Top 5 pays par commandes livrées (sur TOUTE la période, indépendant du filtre country)
      this.prisma.order.groupBy({
        by: ['deliveryCountry'],
        where: { createdAt: { gte: since }, status: 'DELIVERED', deliveryCountry: { not: null } },
        _count: { _all: true },
        _sum: { totalAmount: true },
        orderBy: { _count: { deliveryCountry: 'desc' } },
        take: 5,
      }),
      // Top 5 clients par commandes livrées
      this.prisma.order.groupBy({
        by: ['clientId'],
        where: { ...baseWhere, status: 'DELIVERED' },
        _count: { _all: true },
        _sum: { totalAmount: true },
        orderBy: { _count: { clientId: 'desc' } },
        take: 5,
      }),
      // Top 5 livreurs par livraisons effectuées
      this.prisma.delivery.groupBy({
        by: ['driverId'],
        where: { status: 'DELIVERED', createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { driverId: 'desc' } },
        take: 5,
      }),
      // Top 5 professionnels par commandes livrées
      this.prisma.order.groupBy({
        by: ['professionalId'],
        where: { ...baseWhere, status: 'DELIVERED' },
        _count: { _all: true },
        _sum: { totalAmount: true },
        orderBy: { _count: { professionalId: 'desc' } },
        take: 5,
      }),
      // Liste des villes distinctes (pour dropdown)
      this.prisma.order.findMany({
        where: { deliveryCity: { not: null }, ...geoFilter },
        select: { deliveryCity: true },
        distinct: ['deliveryCity'],
        take: 100,
      }),
    ]);

    // Enrichissement des tops avec les détails utilisateur/pro
    const [topClientUsers, topDriverInfos, topProInfos, topDriverEarnings] = await Promise.all([
      topClientsRaw.length
        ? this.prisma.user.findMany({
            where: { id: { in: topClientsRaw.map(c => c.clientId) } },
            select: { id: true, name: true, firstName: true, phone: true },
          })
        : Promise.resolve([] as any[]),
      topDriversRaw.length
        ? this.prisma.driver.findMany({
            where: { id: { in: topDriversRaw.map(d => d.driverId) } },
            select: { id: true, user: { select: { name: true, firstName: true, phone: true } } },
          })
        : Promise.resolve([] as any[]),
      topProsRaw.length
        ? this.prisma.professional.findMany({
            where: { id: { in: topProsRaw.map(p => p.professionalId) } },
            select: { id: true, businessName: true, category: true, city: true },
          })
        : Promise.resolve([] as any[]),
      // Gains des top livreurs (sum deliveryFee + tips)
      topDriversRaw.length
        ? this.prisma.order.aggregate({
            where: { driverId: { in: topDriversRaw.map(d => d.driverId) }, status: 'DELIVERED', createdAt: { gte: since } },
            _sum: { deliveryFee: true },
          })
        : Promise.resolve({ _sum: { deliveryFee: 0 } } as any),
    ]);
    // _ used to silence "unused var" lints — kept for future per-driver earnings breakdown
    void topDriverEarnings;

    const bucketCount = period === 'month' ? 30 : period === 'day' ? 1 : 7;
    const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    const buckets = new Map<string, { revenue: number; orders: number }>();
    for (let i = bucketCount - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      buckets.set(fmt(d), { revenue: 0, orders: 0 });
    }
    for (const o of rawOrders) {
      const key = fmt(new Date(o.createdAt));
      const b = buckets.get(key);
      if (b) { b.revenue += Number(o.totalAmount ?? 0); b.orders++; }
    }
    const chartData = Array.from(buckets.entries()).map(([day, v]) => ({ day, ...v }));

    const cancelRatePercent = orders._count > 0 ? (cancelRate / orders._count * 100).toFixed(1) : 0;

    const prevSince = new Date(since.getTime() - (now.getTime() - since.getTime()));
    const [prevOrders, prevRevenue, prevUsers] = await Promise.all([
      this.prisma.order.aggregate({ where: { createdAt: { gte: prevSince, lt: since }, ...geoFilter }, _count: true, _sum: { totalAmount: true } }),
      this.prisma.transaction.aggregate({ where: { type: 'COMMISSION', createdAt: { gte: prevSince, lt: since } }, _sum: { amount: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: prevSince, lt: since }, role: 'CLIENT', ...(country ? { countryCode: country } : {}) } }),
    ]);

    // ─── Construction des Top 5 enrichis ──────────────────────────────────
    const clientById = new Map(topClientUsers.map(u => [u.id, u]));
    const driverById = new Map(topDriverInfos.map(d => [d.id, d]));
    const proById    = new Map(topProInfos.map(p => [p.id, p]));

    const topCountries = topCountriesRaw.map(c => ({
      country: c.deliveryCountry,
      ordersCount: c._count._all,
      revenue: c._sum.totalAmount ?? 0,
    }));

    const topClients = topClientsRaw.map(c => {
      const u = clientById.get(c.clientId);
      return {
        id: c.clientId,
        name: [u?.firstName, u?.name].filter(Boolean).join(' ') || u?.phone || '—',
        phone: u?.phone ?? null,
        ordersCount: c._count._all,
        totalSpent: c._sum.totalAmount ?? 0,
      };
    });

    const topDrivers = topDriversRaw.map(d => {
      const drv = driverById.get(d.driverId);
      return {
        id: d.driverId,
        name: [drv?.user?.firstName, drv?.user?.name].filter(Boolean).join(' ') || drv?.user?.phone || '—',
        phone: drv?.user?.phone ?? null,
        deliveriesCount: d._count._all,
      };
    });

    const topPros = topProsRaw.map(p => {
      const pro = proById.get(p.professionalId);
      return {
        id: p.professionalId,
        businessName: pro?.businessName ?? '—',
        category: pro?.category ?? null,
        city: pro?.city ?? null,
        ordersCount: p._count._all,
        revenue: p._sum.totalAmount ?? 0,
      };
    });

    // ─── Finance ─────────────────────────────────────────────────────────
    const f = financeAgg._sum;
    const platformCommissions = Number(f.commissionAmount ?? 0);
    const deliveryFees        = Number(f.deliveryFee ?? 0);
    const driverTips          = Number(tipsAgg._sum.amount ?? 0);
    const proRevenue          = Number(f.subtotal ?? 0) - platformCommissions;
    const driverRevenue       = deliveryFees + driverTips;

    return {
      data: {
        // ── Existant (préservé pour rétrocompatibilité) ──────────────────
        orders: { count: orders._count, revenue: orders._sum.totalAmount ?? 0 },
        commissions: revenue._sum.amount ?? 0,
        newUsers, newProfessionals, newDrivers, activeDeliveries,
        avgRating: avgRating._avg.professionalRating,
        cancelRate: cancelRatePercent,
        chartData,
        prev: {
          orders: { count: prevOrders._count, revenue: prevOrders._sum.totalAmount ?? 0 },
          commissions: prevRevenue._sum.amount ?? 0,
          newUsers: prevUsers,
        },

        // ── Nouveaux compteurs par statut ────────────────────────────────
        counters: {
          total: orders._count,
          toValidate: ordersToValidate,
          inPreparation: ordersInPreparation,
          delivered: ordersDelivered,
          cancelled: ordersCancelled,
        },

        // ── Bloc finance détaillé ────────────────────────────────────────
        finance: {
          revenue: Number(financeAgg._sum.totalAmount ?? 0),
          deliveryFees,
          platformCommissions,
          proRevenue,
          driverRevenue,
          driverTips,
        },

        // ── Livreurs actifs sur la période ───────────────────────────────
        activeDrivers: activeDriversIds.length,

        // ── Répartition utilisateurs (pour pie chart) ────────────────────
        usersByRole: [
          { name: 'Clients',       value: usersClientCount },
          { name: 'Professionnels', value: usersProCount },
          { name: 'Livreurs',      value: usersDriverCount },
        ],

        // ── Tops ─────────────────────────────────────────────────────────
        topCountries,
        topClients,
        topDrivers,
        topPros,

        // ── Listes pour les filtres dynamiques ───────────────────────────
        distinctCities: distinctCitiesRaw
          .map(c => c.deliveryCity)
          .filter((v): v is string => !!v)
          .sort((a, b) => a.localeCompare(b, 'fr')),
      },
    };
  }

  // ─── ANALYTICS ───────────────────────────
  async getAnalytics(period: string = 'month', country?: string, city?: string, from?: string, to?: string) {
    const now = new Date();
    let since: Date;
    let until: Date | undefined;

    if (from && to) {
      since = new Date(from);
      until = new Date(to);
      // Inclure toute la journée de fin
      until.setHours(23, 59, 59, 999);
    } else {
      const periodMap: Record<string, Date> = {
        day: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        month: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      };
      since = periodMap[period] ?? periodMap.month;
    }

    const geoFilter: any = {};
    if (country) geoFilter.deliveryCountry = country;
    if (city)    geoFilter.deliveryCity = city;

    const dateFilter: any = { gte: since };
    if (until) dateFilter.lte = until;

    const baseWhere = { createdAt: dateFilter, ...geoFilter };

    const [totalOrders, deliveredOrders, cancelledOrders, avgBasket, avgEstDelivery, ordersByCountry, ordersWithPro] = await Promise.all([
      this.prisma.order.count({ where: baseWhere }),
      this.prisma.order.count({ where: { ...baseWhere, status: 'DELIVERED' } }),
      this.prisma.order.count({ where: { ...baseWhere, status: 'CANCELLED' } }),
      this.prisma.order.aggregate({ where: { ...baseWhere, status: 'DELIVERED' }, _avg: { totalAmount: true } }),
      this.prisma.order.aggregate({ where: { ...baseWhere, status: 'DELIVERED', estimatedDeliveryMin: { not: null } }, _avg: { estimatedDeliveryMin: true } }),
      this.prisma.order.groupBy({ by: ['deliveryCountry'], where: { ...baseWhere, status: 'DELIVERED', deliveryCountry: { not: null } }, _sum: { totalAmount: true }, _count: true, orderBy: { _sum: { totalAmount: 'desc' } }, take: 8 }),
      this.prisma.order.findMany({ where: baseWhere, select: { clientId: true, professional: { select: { category: true } } }, take: 5000 }),
    ]);

    const completionRate = (totalOrders - cancelledOrders) > 0
      ? Math.round(deliveredOrders / (totalOrders - cancelledOrders) * 100)
      : 0;

    // category breakdown
    const catCounts: Record<string, number> = {};
    for (const o of ordersWithPro) {
      const cat = o.professional?.category ?? 'OTHER';
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
    }
    const catLabels: Record<string, string> = {
      RESTAURANT: 'Restaurant', GROCERY: 'Épicerie', SUPERMARKET: 'Supermarché',
      BAKERY: 'Boulangerie', PHARMACY: 'Pharmacie', OTHER: 'Autre',
    };
    const total = ordersWithPro.length || 1;
    const byCategory = Object.entries(catCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([key, count]) => ({ name: catLabels[key] ?? key, value: Math.round(count / total * 100) }));

    // retention: users with 2+ orders vs users with any order
    const clientCounts: Record<string, number> = {};
    for (const o of ordersWithPro) { clientCounts[o.clientId] = (clientCounts[o.clientId] ?? 0) + 1; }
    const withOrders = Object.keys(clientCounts).length;
    const withRepeat = Object.values(clientCounts).filter(c => c >= 2).length;
    const retentionRate = withOrders > 0 ? Math.round(withRepeat / withOrders * 100) : 0;

    // funnel
    const totalUsers = await this.prisma.user.count({ where: { role: 'CLIENT', ...(country ? { countryCode: country } : {}) } });
    const funnelMax = totalUsers || 1;
    const funnel = [
      { label: 'Clients inscrits', value: totalUsers, pct: 100, color: 'bg-brand-green' },
      { label: 'Ont commandé', value: withOrders, pct: Math.round(withOrders / funnelMax * 100), color: 'bg-blue-500' },
      { label: 'Clients fidèles', value: withRepeat, pct: Math.round(withRepeat / funnelMax * 100), color: 'bg-purple-500' },
    ];

    return {
      data: {
        completionRate,
        avgBasket: avgBasket._avg.totalAmount ?? 0,
        avgDeliveryMin: avgEstDelivery._avg.estimatedDeliveryMin ? Math.round(avgEstDelivery._avg.estimatedDeliveryMin) : null,
        retentionRate,
        byCountry: ordersByCountry.map(r => ({ name: r.deliveryCountry ?? '?', revenue: r._sum.totalAmount ?? 0, orders: r._count })),
        byCategory,
        funnel,
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

  // ─── DRIVERS PENDING ──────────────────────
  /// Symétrique de getPendingProfessionals — utilisé par l'écran admin
  /// mobile (onglet 'Livreurs' dans /admin/pending).
  async getPendingDrivers() {
    return this.prisma.driver.findMany({
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
  async getUsers(role?: string, pagination?: PaginationDto, country?: string) {
    const where: any = {};
    if (role) where.role = role;
    if (country) where.countryCode = country;
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: pagination?.skip, take: pagination?.limit }),
      this.prisma.user.count({ where }),
    ]);
    return { data: users, meta: { total } };
  }

  async updateUserStatus(id: string, status: string) {
    return this.prisma.user.update({ where: { id }, data: { status: status as any } });
  }

  async deleteUser(id: string) {
    await this.prisma.user.update({ where: { id }, data: { status: 'BANNED' as any, deletedAt: new Date() } }).catch(() =>
      this.prisma.user.update({ where: { id }, data: { status: 'BANNED' as any } })
    );
    return { success: true };
  }

  async createUser(dto: {
    phone: string; phoneCountry: string; firstName?: string; name?: string;
    email?: string; role?: string; countryCode?: string; currency?: string;
  }) {
    const existing = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (existing) throw new Error(`Le numéro ${dto.phone} est déjà utilisé.`);
    const user = await this.prisma.user.create({
      data: {
        phone: dto.phone,
        phoneCountry: dto.phoneCountry || dto.countryCode || 'BJ',
        firstName: dto.firstName,
        name: dto.name,
        email: dto.email || undefined,
        role: (dto.role as any) || 'CLIENT',
        countryCode: dto.countryCode || 'BJ',
        currency: dto.currency || 'XOF',
        status: 'ACTIVE' as any,
      },
    });
    return { data: user };
  }

  async updateUserProfile(id: string, dto: {
    firstName?: string; name?: string; email?: string;
    countryCode?: string; currency?: string; phone?: string;
  }) {
    if (dto.phone) {
      const conflict = await this.prisma.user.findFirst({ where: { phone: dto.phone, NOT: { id } } });
      if (conflict) throw new Error(`Le numéro ${dto.phone} est déjà utilisé.`);
    }
    if (dto.email) {
      const conflict = await this.prisma.user.findFirst({ where: { email: dto.email, NOT: { id } } });
      if (conflict) throw new Error(`L'email ${dto.email} est déjà utilisé.`);
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.name      !== undefined && { name: dto.name }),
        ...(dto.email     !== undefined && { email: dto.email || null }),
        ...(dto.countryCode !== undefined && { countryCode: dto.countryCode }),
        ...(dto.currency    !== undefined && { currency: dto.currency }),
        ...(dto.phone       !== undefined && { phone: dto.phone }),
      },
    });
    return { data: user };
  }

  async ensureReferralCode(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new Error('Utilisateur introuvable.');
    if (user.referralCode) return { data: { referralCode: user.referralCode } };
    // Génère un code unique de 8 caractères (lettres + chiffres)
    let code: string;
    let attempts = 0;
    do {
      code = Math.random().toString(36).substring(2, 10).toUpperCase();
      attempts++;
    } while (attempts < 10 && await this.prisma.user.findUnique({ where: { referralCode: code } }));
    const updated = await this.prisma.user.update({ where: { id }, data: { referralCode: code } });
    return { data: { referralCode: updated.referralCode } };
  }

  // ─── CATALOGUE ADMIN ─────────────────────
  async getCatalogueForPro(proId: string) {
    const [professional, categories] = await Promise.all([
      this.prisma.professional.findUnique({ where: { id: proId }, select: { id: true, businessName: true, category: true, city: true } }),
      this.prisma.productCategory.findMany({
        where: { professionalId: proId },
        orderBy: { sortOrder: 'asc' },
        include: { products: { orderBy: { createdAt: 'asc' } } },
      }),
    ]);
    if (!professional) throw new NotFoundException('Professionnel introuvable');
    return { data: { professional, categories } };
  }

  async createCatalogueCategory(proId: string, dto: { name: any; icon?: string }) {
    return this.prisma.productCategory.create({ data: { professionalId: proId, name: dto.name, icon: dto.icon } });
  }

  async deleteCatalogueCategory(categoryId: string) {
    await this.prisma.$transaction([
      this.prisma.product.updateMany({ where: { categoryId }, data: { categoryId: null } }),
      this.prisma.productCategory.delete({ where: { id: categoryId } }),
    ]);
    return { success: true };
  }

  async createCatalogueProduct(proId: string, dto: any) {
    const { categoryId, name, description, price, currency, imageUrl, isAvailable, stock, variants } = dto;
    return this.prisma.product.create({
      data: { professionalId: proId, categoryId: categoryId ?? null, name, description: description ?? null, price: Number(price), currency: currency ?? 'XOF', imageUrl: imageUrl ?? null, isAvailable: isAvailable ?? true, stock: stock ?? null, variants: variants ?? null },
    });
  }

  async updateCatalogueProduct(productId: string, dto: any) {
    return this.prisma.product.update({ where: { id: productId }, data: dto });
  }

  async deleteCatalogueProduct(productId: string) {
    await this.prisma.product.delete({ where: { id: productId } });
    return { success: true };
  }

  async toggleCatalogueProduct(productId: string) {
    const p = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!p) throw new NotFoundException();
    return this.prisma.product.update({ where: { id: productId }, data: { isAvailable: !p.isAvailable } });
  }

  // ─── DRIVER DETAIL + MISSIONS ────────────
  async getDriverDetail(id: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, status: true, countryCode: true, createdAt: true } },
        documents: true,
      },
    });
    if (!driver) throw new NotFoundException();
    return { data: driver };
  }

  async getDriverMissions(id: string) {
    const orders = await this.prisma.order.findMany({
      where: { driverId: id },
      include: {
        client: { select: { name: true, phone: true } },
        professional: { select: { businessName: true, city: true } },
        payment: { select: { status: true, amount: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { data: orders };
  }

  // ─── PROFESSIONAL DETAIL + ORDERS ────────
  async getProfessionalDetail(id: string) {
    const pro = await this.prisma.professional.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, status: true, countryCode: true, createdAt: true } },
        documents: true,
      },
    });
    if (!pro) throw new NotFoundException();
    return { data: pro };
  }

  async getProfessionalOrders(id: string) {
    const [orders, stats] = await Promise.all([
      this.prisma.order.findMany({
        where: { professionalId: id },
        include: {
          client: { select: { name: true, phone: true } },
          driver: { include: { user: { select: { name: true } } } },
          payment: { select: { status: true, amount: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.order.aggregate({
        where: { professionalId: id },
        _count: true,
        _sum: { totalAmount: true },
      }),
    ]);
    return { data: { orders, stats: { total: stats._count, revenue: stats._sum.totalAmount ?? 0 } } };
  }

  // ─── PROFESSIONALS MANAGEMENT ────────────
  async getAllProfessionals(pagination?: PaginationDto) {
    const [professionals, total] = await Promise.all([
      this.prisma.professional.findMany({
        include: { user: { select: { name: true, phone: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: pagination?.skip, take: pagination?.limit ?? 100,
      }),
      this.prisma.professional.count(),
    ]);
    return { data: professionals, meta: { total } };
  }

  // ─── DRIVERS MANAGEMENT ───────────────────
  async getAllDrivers(pagination?: PaginationDto) {
    const [drivers, total] = await Promise.all([
      this.prisma.driver.findMany({
        include: { user: { select: { name: true, phone: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: pagination?.skip, take: pagination?.limit ?? 100,
      }),
      this.prisma.driver.count(),
    ]);
    return { data: drivers, meta: { total } };
  }

  // ─── ORDERS MANAGEMENT ────────────────────
  /** Liste des villes distinctes où des commandes ont été placées. */
  async getDistinctCities(country?: string) {
    const rows = await this.prisma.order.findMany({
      where: { deliveryCity: { not: null }, ...(country ? { deliveryCountry: country } : {}) },
      select: { deliveryCity: true },
      distinct: ['deliveryCity'],
      take: 200,
    });
    return {
      data: rows
        .map(r => r.deliveryCity)
        .filter((v): v is string => !!v)
        .sort((a, b) => a.localeCompare(b, 'fr')),
    };
  }

  async getAllOrders(filters: any, pagination: PaginationDto) {
    const where: any = {};
    // Le frontend peut envoyer "PAID,IN_PREPARATION,IN_DELIVERY" (CSV).
    // Prisma attend un enum unique OU { in: [...] } pour plusieurs valeurs.
    if (filters.status) {
      const statuses = String(filters.status)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
    }
    if (filters.country) where.deliveryCountry = filters.country;
    if (filters.city)    where.deliveryCity    = filters.city;
    // Période (jour/semaine/mois) — calculée côté backend pour rester
    // cohérent avec /admin/dashboard. Si `from/to` explicites sont fournis,
    // ils prennent le pas sur `period`.
    if (filters.from && filters.to) {
      where.createdAt = { gte: new Date(filters.from), lte: new Date(filters.to) };
    } else if (filters.period) {
      const now = Date.now();
      const ms: Record<string, number> = {
        day:   24 * 60 * 60 * 1000,
        week:  7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      const range = ms[filters.period];
      if (range) where.createdAt = { gte: new Date(now - range) };
    }

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
  async getPromoCodes() {
    return this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createPromoCode(dto: any) {
    const { code, type, value, minOrder, maxUses, perUser, expiresAt, countries } = dto;
    return this.prisma.promoCode.create({
      data: {
        code: String(code).toUpperCase().trim(),
        type,
        value: Number(value),
        minOrder: Number(minOrder ?? 0),
        maxUses: maxUses ? Number(maxUses) : null,
        perUser: Boolean(perUser ?? false),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        countries: Array.isArray(countries) ? countries : [],
      },
    });
  }

  async updatePromoCode(id: string, dto: any) {
    const { code, type, value, minOrder, maxUses, perUser, expiresAt, countries } = dto;
    return this.prisma.promoCode.update({
      where: { id },
      data: {
        ...(code !== undefined && { code: String(code).toUpperCase().trim() }),
        ...(type !== undefined && { type }),
        ...(value !== undefined && { value: Number(value) }),
        ...(minOrder !== undefined && { minOrder: Number(minOrder) }),
        ...(maxUses !== undefined && { maxUses: maxUses ? Number(maxUses) : null }),
        ...(perUser !== undefined && { perUser: Boolean(perUser) }),
        ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
        ...(countries !== undefined && { countries: Array.isArray(countries) ? countries : [] }),
      },
    });
  }

  async togglePromoCode(id: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException();
    return this.prisma.promoCode.update({ where: { id }, data: { isActive: !promo.isActive } });
  }

  async deletePromoCode(id: string) {
    await this.prisma.promoCode.delete({ where: { id } });
    return { success: true };
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

  // ─── REFERRAL ─────────────────────────────
  async getReferrals() {
    const [referrals, total, pending, rewarded, totalCredits] = await Promise.all([
      this.prisma.referral.findMany({
        include: {
          referrer: { select: { id: true, name: true, firstName: true, phone: true } },
          referee:  { select: { id: true, name: true, firstName: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.referral.count(),
      this.prisma.referral.count({ where: { status: 'PENDING' } }),
      this.prisma.referral.count({ where: { status: 'REWARDED' } }),
      this.prisma.walletTransaction.aggregate({ where: { type: 'REFERRAL_REWARD' as any }, _sum: { amount: true } }),
    ]);
    return { data: { referrals, stats: { total, pending, rewarded, totalCredits: totalCredits._sum.amount ?? 0 } } };
  }

  async getReferralConfig() {
    const [amountCfg, enabledCfg] = await Promise.all([
      this.prisma.platformConfig.findUnique({ where: { key: 'referral_reward_amount' } }),
      this.prisma.platformConfig.findUnique({ where: { key: 'referral_enabled' } }),
    ]);
    return {
      data: {
        rewardAmount: amountCfg ? Number(amountCfg.value) : 500,
        enabled: enabledCfg ? Boolean(enabledCfg.value) : true,
      },
    };
  }

  async updateReferralConfig(rewardAmount: number, enabled: boolean) {
    await Promise.all([
      this.prisma.platformConfig.upsert({
        where: { key: 'referral_reward_amount' },
        create: { key: 'referral_reward_amount', value: rewardAmount },
        update: { value: rewardAmount },
      }),
      this.prisma.platformConfig.upsert({
        where: { key: 'referral_enabled' },
        create: { key: 'referral_enabled', value: enabled },
        update: { value: enabled },
      }),
    ]);
    return { data: { rewardAmount, enabled } };
  }

  // ─── WALLET ───────────────────────────────
  async getUserWallet(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
    return { data: wallet ?? { balance: 0, transactions: [] } };
  }

  async adjustWallet(userId: string, amount: number, type: 'ADMIN_CREDIT' | 'ADMIN_DEBIT', description?: string) {
    let wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({ data: { userId, balance: 0 } });
    }
    const delta = type === 'ADMIN_DEBIT' ? -Math.abs(amount) : Math.abs(amount);
    if (wallet.balance + delta < 0) throw new BadRequestException('Solde insuffisant pour ce débit');
    await this.prisma.$transaction([
      this.prisma.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: delta } } }),
      this.prisma.walletTransaction.create({ data: { walletId: wallet.id, amount: delta, type: type as any, description } }),
    ]);
    return { data: { balance: wallet.balance + delta } };
  }
}
