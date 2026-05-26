import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadsService } from '../uploads/uploads.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private uploads: UploadsService,
  ) {}

  // ─── DASHBOARD ────────────────────────────
  async getDashboard(period: string = 'week', country?: string, city?: string, from?: string, to?: string) {
    const now = new Date();
    let since: Date;
    let until: Date | undefined;

    if (period === 'custom' && from) {
      since = new Date(from);
      until = to ? new Date(to + 'T23:59:59.999Z') : now;
    } else {
      const periodMap: Record<string, Date> = {
        day:   new Date(now.getTime() - 24 * 60 * 60 * 1000),
        week:  new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        month: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      };
      since = periodMap[period] ?? periodMap.week;
    }

    const geoFilter  = country ? { deliveryCountry: country } : {};
    const cityFilter = city    ? { deliveryCity: city }       : {};
    const dateFilter = { gte: since, ...(until ? { lte: until } : {}) };
    const baseWhere  = { createdAt: dateFilter, ...geoFilter, ...cityFilter };

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

    let chartData: { day: string; revenue: number; orders: number }[];

    if (period === 'day') {
      // Tranches horaires sur 24h
      const hourBuckets = new Map<string, { revenue: number; orders: number }>();
      for (let h = 0; h < 24; h++) {
        hourBuckets.set(`${String(h).padStart(2, '0')}h`, { revenue: 0, orders: 0 });
      }
      for (const o of rawOrders) {
        const h = new Date(o.createdAt).getHours();
        const key = `${String(h).padStart(2, '0')}h`;
        const b = hourBuckets.get(key);
        if (b) { b.revenue += Number(o.totalAmount ?? 0); b.orders++; }
      }
      chartData = Array.from(hourBuckets.entries()).map(([day, v]) => ({ day, ...v }));
    } else {
      const effectiveEnd = until ?? now;
      const daysDiff = Math.ceil((effectiveEnd.getTime() - since.getTime()) / (24 * 60 * 60 * 1000));
      const bucketCount = Math.min(Math.max(daysDiff, 1), 90);
      const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      const buckets = new Map<string, { revenue: number; orders: number }>();
      for (let i = bucketCount - 1; i >= 0; i--) {
        const d = new Date(effectiveEnd);
        d.setDate(d.getDate() - i);
        buckets.set(fmt(d), { revenue: 0, orders: 0 });
      }
      for (const o of rawOrders) {
        const key = fmt(new Date(o.createdAt));
        const b = buckets.get(key);
        if (b) { b.revenue += Number(o.totalAmount ?? 0); b.orders++; }
      }
      chartData = Array.from(buckets.entries()).map(([day, v]) => ({ day, ...v }));
    }

    const cancelRatePercent = orders._count > 0 ? (cancelRate / orders._count * 100).toFixed(1) : 0;

    const effectiveEnd = until ?? now;
    const prevSince = new Date(since.getTime() - (effectiveEnd.getTime() - since.getTime()));
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
      include: { user: { select: { name: true, firstName: true, phone: true, email: true, createdByAdmin: true, lastLoginAt: true } }, documents: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── DRIVERS PENDING ──────────────────────
  /// Symétrique de getPendingProfessionals — utilisé par l'écran admin
  /// mobile (onglet 'Livreurs' dans /admin/pending).
  async getPendingDrivers() {
    return this.prisma.driver.findMany({
      where: { status: 'PENDING' },
      include: { user: { select: { name: true, firstName: true, phone: true, email: true, createdByAdmin: true, lastLoginAt: true } }, documents: true },
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
    phone: string; phoneCountry?: string; firstName?: string; name?: string;
    email?: string; role?: string; countryCode?: string; currency?: string;
    pin?: string;
  }) {
    const existing = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (existing) throw new Error(`Le numéro ${dto.phone} est déjà utilisé.`);

    const bcrypt = await import('bcrypt');
    const pinRaw = dto.pin?.trim() || '0000';
    const pinHash = await bcrypt.hash(pinRaw, 12);

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
        pinHash,
        createdByAdmin: true,
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

  async getReferralCode(id: string) {
    const user = (await this.prisma.user.findUnique({ where: { id } })) as any;
    if (!user) throw new Error('Utilisateur introuvable.');
    return { data: { referralCode: user.referralCode ?? null } };
  }

  async ensureReferralCode(id: string) {
    const user = (await this.prisma.user.findUnique({ where: { id } })) as any;
    if (!user) throw new Error('Utilisateur introuvable.');
    if (user.referralCode) return { data: { referralCode: user.referralCode } };
    // Génère un code unique de 8 caractères (lettres + chiffres)
    let code: string;
    let attempts = 0;
    do {
      code = Math.random().toString(36).substring(2, 10).toUpperCase();
      attempts++;
    } while (attempts < 10 && await (this.prisma.user as any).findUnique({ where: { referralCode: code } }));
    const updated = (await this.prisma.user.update({ where: { id }, data: { referralCode: code } as any })) as any;
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

  async uploadCatalogueImage(file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Fichier requis');
    const url = await this.uploads.uploadFile(file, 'ife-food/products');
    return { data: { url } };
  }

  // ─── DRIVER DETAIL + MISSIONS ────────────
  async getDriverDetail(id: string) {
    const [driver, tipStats] = await Promise.all([
      this.prisma.driver.findUnique({
        where: { id },
        include: {
          user: { select: { id: true, name: true, firstName: true, phone: true, email: true, status: true, countryCode: true, createdAt: true, createdByAdmin: true, lastLoginAt: true } },
          documents: true,
          selectedZones: { include: { deliveryZone: true } },
        },
      }),
      this.prisma.transaction.aggregate({
        where: { driverId: id, type: 'TIP' as any, status: 'COMPLETED' as any },
        _sum: { amount: true },
        _count: { id: true },
      }),
    ]);
    if (!driver) throw new NotFoundException();
    return {
      data: {
        ...driver,
        tipStats: {
          totalTips: tipStats._sum.amount ?? 0,
          tipCount: tipStats._count.id ?? 0,
        },
      },
    };
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
        user: { select: { id: true, name: true, firstName: true, phone: true, email: true, status: true, countryCode: true, createdAt: true, createdByAdmin: true, lastLoginAt: true } },
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
  async getAllProfessionals(pagination?: PaginationDto, filters?: { country?: string; city?: string; category?: string; status?: string }) {
    const where: any = {};
    if (filters?.country)  where.country  = filters.country;
    if (filters?.city)     where.city     = filters.city;
    if (filters?.category) where.category = filters.category;
    if (filters?.status)   where.status   = filters.status;

    const [professionals, total] = await Promise.all([
      this.prisma.professional.findMany({
        where,
        include: { user: { select: { name: true, firstName: true, phone: true, email: true, createdByAdmin: true, lastLoginAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip: pagination?.skip, take: pagination?.limit ?? 200,
      }),
      this.prisma.professional.count({ where }),
    ]);
    return { data: professionals, meta: { total } };
  }

  async createProfessional(dto: {
    businessName: string; category: string; city: string; country: string; address: string;
    lat?: number; lng?: number; phone?: string; email?: string; description?: string;
    ownerPhone: string; ownerFirstName?: string; ownerName?: string;
    ownerEmail?: string; ownerCountryCode?: string; ownerPin?: string;
  }) {
    const existing = await this.prisma.user.findUnique({ where: { phone: dto.ownerPhone } });
    if (existing) throw new Error(`Un compte existe déjà avec le numéro ${dto.ownerPhone}.`);

    const bcrypt = await import('bcrypt');
    const pinRaw = dto.ownerPin?.trim() || '0000';
    const pinHash = await bcrypt.hash(pinRaw, 12);

    const user = await this.prisma.user.create({
      data: {
        phone: dto.ownerPhone,
        phoneCountry: dto.ownerCountryCode || dto.country || 'BJ',
        firstName: dto.ownerFirstName,
        name: dto.ownerName,
        email: dto.ownerEmail || undefined,
        role: 'PROFESSIONAL' as any,
        countryCode: dto.ownerCountryCode || dto.country || 'BJ',
        currency: 'XOF',
        status: 'ACTIVE' as any,
        pinHash,
        createdByAdmin: true,
      },
    });
    const pro = await this.prisma.professional.create({
      data: {
        userId: user.id,
        businessName: dto.businessName,
        category: dto.category as any,
        city: dto.city,
        country: dto.country,
        address: dto.address,
        lat: dto.lat ?? 0,
        lng: dto.lng ?? 0,
        phone: dto.phone,
        email: dto.email,
        description: dto.description,
        status: 'VALIDATED' as any,
      },
      include: { user: { select: { name: true, firstName: true, phone: true, email: true, createdByAdmin: true, lastLoginAt: true } } },
    });
    return { data: pro };
  }

  async updateProfessional(id: string, dto: {
    businessName?: string; category?: string; city?: string; country?: string;
    address?: string; phone?: string; email?: string; description?: string;
    commissionRate?: number; deliveryRadiusKm?: number;
  }) {
    const pro = await this.prisma.professional.update({
      where: { id },
      data: {
        ...(dto.businessName     !== undefined && { businessName:     dto.businessName }),
        ...(dto.category         !== undefined && { category:         dto.category as any }),
        ...(dto.city             !== undefined && { city:             dto.city }),
        ...(dto.country          !== undefined && { country:          dto.country }),
        ...(dto.address          !== undefined && { address:          dto.address }),
        ...(dto.phone            !== undefined && { phone:            dto.phone }),
        ...(dto.email            !== undefined && { email:            dto.email }),
        ...(dto.description      !== undefined && { description:      dto.description }),
        ...(dto.commissionRate   !== undefined && { commissionRate:   Number(dto.commissionRate) }),
        ...(dto.deliveryRadiusKm !== undefined && { deliveryRadiusKm: Number(dto.deliveryRadiusKm) }),
      },
      include: { user: { select: { name: true, firstName: true, phone: true, email: true, createdByAdmin: true, lastLoginAt: true } } },
    });
    return { data: pro };
  }

  async deleteProfessional(id: string) {
    const pro = await this.prisma.professional.findUnique({ where: { id } });
    if (!pro) throw new Error('Établissement introuvable.');
    await this.prisma.professional.update({ where: { id }, data: { status: 'BANNED' as any } });
    await this.prisma.user.update({ where: { id: pro.userId }, data: { status: 'BANNED' as any, deletedAt: new Date() } }).catch(() => {});
    return { success: true };
  }

  async getProPromoCodes(proId: string) {
    const codes = await this.prisma.promoCode.findMany({
      where: { professionalId: proId },
      orderBy: { createdAt: 'desc' },
    });
    return { data: codes };
  }

  // ─── DRIVERS MANAGEMENT ───────────────────
  async getAllDrivers(pagination?: PaginationDto, filters?: { country?: string; city?: string; vehicleType?: string; status?: string }) {
    const where: any = {};
    if (filters?.country)     where.zoneCountry  = filters.country;
    if (filters?.city)        where.zoneCity     = { contains: filters.city, mode: 'insensitive' };
    if (filters?.vehicleType) where.vehicleType  = filters.vehicleType;
    if (filters?.status)      where.status       = filters.status;

    const [drivers, total] = await Promise.all([
      this.prisma.driver.findMany({
        where,
        include: {
          user: { select: { name: true, firstName: true, phone: true, email: true, createdByAdmin: true, lastLoginAt: true } },
          selectedZones: { include: { deliveryZone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination?.skip, take: pagination?.limit ?? 200,
      }),
      this.prisma.driver.count({ where }),
    ]);
    return { data: drivers, meta: { total } };
  }

  async createDriver(dto: any) {
    const { phone, name, firstName, email, pin, vehicleType, zoneCity, zoneCountry, licensePlate, deliveryZoneIds } = dto;
    if (!phone) throw new BadRequestException('Le numéro de téléphone est obligatoire.');
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) throw new BadRequestException('Ce numéro de téléphone est déjà utilisé.');

    const bcrypt = await import('bcrypt');
    const pinRaw = pin?.trim() || '0000';
    const pinHash = await bcrypt.hash(pinRaw, 12);

    const user = await this.prisma.user.create({
      data: {
        phone,
        phoneCountry: zoneCountry || 'BJ',
        name: name || phone,
        firstName: firstName || null,
        email: email || null,
        role: 'DRIVER' as any,
        countryCode: zoneCountry || 'BJ',
        currency: 'XOF',
        status: 'ACTIVE' as any,
        pinHash,
        createdByAdmin: true,
      },
    });

    const driver = await this.prisma.driver.create({
      data: {
        userId: user.id,
        vehicleType: vehicleType || 'MOTORCYCLE',
        zoneCity: zoneCity || null,
        zoneCountry: zoneCountry || 'BJ',
        licensePlate: licensePlate || null,
        status: 'PENDING',
      },
    });

    if (Array.isArray(deliveryZoneIds) && deliveryZoneIds.length > 0) {
      await this.prisma.driverDeliveryZone.createMany({
        data: (deliveryZoneIds as string[]).map(zoneId => ({ driverId: driver.id, deliveryZoneId: zoneId })),
        skipDuplicates: true,
      });
    }

    const fullDriver = await this.prisma.driver.findUnique({
      where: { id: driver.id },
      include: {
        user: { select: { name: true, firstName: true, phone: true, email: true, createdByAdmin: true, lastLoginAt: true } },
        selectedZones: { include: { deliveryZone: true } },
      },
    });

    return { data: fullDriver };
  }

  async updateDriver(id: string, dto: any) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException('Livreur introuvable.');

    const { name, firstName, email, vehicleType, zoneCity, zoneCountry, licensePlate, deliveryZoneIds } = dto;

    if (name || firstName || email) {
      await this.prisma.user.update({
        where: { id: driver.userId },
        data: {
          ...(name !== undefined       ? { name }      : {}),
          ...(firstName !== undefined  ? { firstName } : {}),
          ...(email !== undefined      ? { email }     : {}),
        },
      });
    }

    await this.prisma.driver.update({
      where: { id },
      data: {
        ...(vehicleType !== undefined  ? { vehicleType }  : {}),
        ...(zoneCity !== undefined     ? { zoneCity }     : {}),
        ...(zoneCountry !== undefined  ? { zoneCountry }  : {}),
        ...(licensePlate !== undefined ? { licensePlate } : {}),
      },
    });

    if (Array.isArray(deliveryZoneIds)) {
      await this.prisma.driverDeliveryZone.deleteMany({ where: { driverId: id } });
      if (deliveryZoneIds.length > 0) {
        await this.prisma.driverDeliveryZone.createMany({
          data: (deliveryZoneIds as string[]).map(zoneId => ({ driverId: id, deliveryZoneId: zoneId })),
          skipDuplicates: true,
        });
      }
    }

    const updated = await this.prisma.driver.findUnique({
      where: { id },
      include: {
        user: { select: { name: true, firstName: true, phone: true, email: true, createdByAdmin: true, lastLoginAt: true } },
        selectedZones: { include: { deliveryZone: true } },
      },
    });

    return { data: updated };
  }

  async deleteDriver(id: string) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException('Livreur introuvable.');
    await this.prisma.driver.update({ where: { id }, data: { status: 'BANNED' as any } });
    await this.prisma.user.update({ where: { id: driver.userId }, data: { status: 'BANNED' as any, deletedAt: new Date() } }).catch(() => {});
    return { success: true };
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
          driver: { include: { user: { select: { name: true, phone: true } } } },
          items: { include: { product: { select: { name: true } } } },
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

  // ─── PAYMENTS / CONFIG ───────────────────
  async getCommissionConfig() {
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'commission' } });
    const raw = cfg?.value && typeof cfg.value === 'object' ? (cfg.value as any) : {};
    // Backward compat: old format { type, value } → wrap as professional
    const professional = raw.professional ?? (raw.type ? { type: raw.type, value: raw.value } : { type: 'PERCENTAGE', value: 15 });
    const driver   = raw.driver   ?? { type: 'PERCENTAGE', value: 10 };
    const countries = raw.countries ?? {};
    return { data: { professional, driver, countries } };
  }

  async getPlatformConfig() {
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentGateways' } });
    return { data: { paymentGateways: cfg?.value ?? { STRIPE: true, PAYPAL: true, KKIAPAY: true, FEDAPAY: true, CASH_ON_DELIVERY: true } } };
  }

  async getPaymentStats() {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [monthlyRev, monthlyComm, monthlyFees, pendingPayouts, totalTx, gatewayRaw] = await Promise.all([
      this.prisma.order.aggregate({ where: { createdAt: { gte: startOfMonth }, paymentStatus: 'SUCCESS' as any }, _sum: { totalAmount: true } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: startOfMonth }, paymentStatus: 'SUCCESS' as any }, _sum: { commissionAmount: true } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: startOfMonth }, paymentStatus: 'SUCCESS' as any }, _sum: { deliveryFee: true } }),
      this.prisma.transaction.count({ where: { type: 'PAYOUT' as any, status: 'PENDING' as any } }),
      this.prisma.transaction.count(),
      this.prisma.order.groupBy({
        by: ['paymentMethod'],
        _count: { id: true },
        _sum: { totalAmount: true },
        where: { paymentStatus: 'SUCCESS' as any },
      }),
    ]);

    return {
      data: {
        monthlyRevenue:      monthlyRev._sum.totalAmount  ?? 0,
        monthlyCommissions:  monthlyComm._sum.commissionAmount ?? 0,
        monthlyDeliveryFees: monthlyFees._sum.deliveryFee ?? 0,
        pendingPayouts,
        totalTransactions: totalTx,
        gatewayStats: gatewayRaw.map((g: any) => ({
          gateway: g.paymentMethod,
          count:   g._count.id,
          total:   g._sum.totalAmount ?? 0,
        })),
      },
    };
  }

  async getCommissionStats(country?: string) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const baseWhere: any = { paymentStatus: 'SUCCESS' as any };
    if (country) baseWhere.deliveryCountry = country;
    const recentWhere: any = { ...baseWhere, createdAt: { gte: sixMonthsAgo } };

    // Read driver commission rate from config to compute driver slice of delivery fees
    const cfgRow = await this.prisma.platformConfig.findUnique({ where: { key: 'commission' } });
    const cfgRaw = cfgRow?.value && typeof cfgRow.value === 'object' ? (cfgRow.value as any) : {};
    const driverCfg  = cfgRaw.driver  ?? { type: 'PERCENTAGE', value: 10 };
    // Per-country override if exists
    const countryCfg = country && cfgRaw.countries?.[country];
    const effectiveDriver = countryCfg?.driver ?? driverCfg;

    const [totals, recent, topRaw, totalOrderCount] = await Promise.all([
      this.prisma.order.aggregate({
        where: baseWhere,
        _sum: { commissionAmount: true, totalAmount: true, deliveryFee: true },
      }),
      this.prisma.order.findMany({
        where: recentWhere,
        select: { createdAt: true, commissionAmount: true, totalAmount: true, deliveryFee: true },
      }),
      this.prisma.order.groupBy({
        by: ['professionalId'],
        _sum: { commissionAmount: true, totalAmount: true },
        _count: { id: true },
        where: baseWhere,
        orderBy: { _sum: { commissionAmount: 'desc' } },
        take: 5,
      }),
      this.prisma.order.count({ where: baseWhere }),
    ]);

    // Compute driver commission from delivery fees
    const totalDeliveryFees  = totals._sum.deliveryFee ?? 0;
    const driverRate         = effectiveDriver.type === 'PERCENTAGE' ? (effectiveDriver.value ?? 10) / 100 : 0;
    const totalDriverComm    = effectiveDriver.type === 'PERCENTAGE'
      ? Math.round(totalDeliveryFees * driverRate)
      : Math.round(totalOrderCount * (effectiveDriver.value ?? 0));

    const totalProComm       = totals._sum.commissionAmount ?? 0;
    const totalPlatformComm  = totalProComm + totalDriverComm;

    const monthlyMap = new Map<string, { revenue: number; proCommissions: number; driverCommissions: number }>();
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyMap.set(key, { revenue: 0, proCommissions: 0, driverCommissions: 0 });
    }
    for (const o of recent) {
      const d = new Date(o.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthlyMap.has(key)) {
        const e = monthlyMap.get(key)!;
        e.revenue         += Number(o.totalAmount ?? 0);
        e.proCommissions  += Number(o.commissionAmount ?? 0);
        e.driverCommissions += effectiveDriver.type === 'PERCENTAGE'
          ? Math.round(Number(o.deliveryFee ?? 0) * driverRate)
          : (effectiveDriver.value ?? 0);
      }
    }

    const proIds = topRaw.map((p: any) => p.professionalId);
    const pros = proIds.length > 0
      ? await this.prisma.professional.findMany({ where: { id: { in: proIds } }, select: { id: true, businessName: true, country: true } })
      : [];
    const proMap = new Map(pros.map(p => [p.id, p]));

    return {
      data: {
        totalProCommissions:     totalProComm,
        totalDriverCommissions:  totalDriverComm,
        totalPlatformCommissions: totalPlatformComm,
        totalRevenue:             totals._sum.totalAmount ?? 0,
        totalDeliveryFees,
        monthly: Array.from(monthlyMap.entries()).map(([month, v]) => ({ month, ...v })),
        topCommissioners: topRaw.map((p: any) => ({
          professional: proMap.get(p.professionalId),
          commissions:  p._sum.commissionAmount ?? 0,
          revenue:      p._sum.totalAmount      ?? 0,
          orders:       p._count.id,
        })),
      },
    };
  }

  async getDeliveryFeeStats() {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    sixMonthsAgo.setDate(1);

    const [totals, byCity, recent] = await Promise.all([
      this.prisma.order.aggregate({ where: { paymentStatus: 'SUCCESS' as any }, _sum: { deliveryFee: true }, _count: { id: true } }),
      this.prisma.order.groupBy({
        by: ['deliveryCity'],
        _sum: { deliveryFee: true },
        _count: { id: true },
        where: { paymentStatus: 'SUCCESS' as any, deliveryCity: { not: null } },
        orderBy: { _sum: { deliveryFee: 'desc' } },
        take: 5,
      }),
      this.prisma.order.findMany({
        where: { createdAt: { gte: sixMonthsAgo }, paymentStatus: 'SUCCESS' as any },
        select: { createdAt: true, deliveryFee: true },
      }),
    ]);

    const monthlyMap = new Map<string, { fees: number; orders: number }>();
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyMap.set(key, { fees: 0, orders: 0 });
    }
    for (const o of recent) {
      const d = new Date(o.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthlyMap.has(key)) {
        const e = monthlyMap.get(key)!;
        e.fees   += o.deliveryFee;
        e.orders += 1;
      }
    }

    return {
      data: {
        totalFees:    totals._sum.deliveryFee ?? 0,
        totalOrders:  totals._count.id,
        avgFee:       totals._count.id > 0 ? Math.round((totals._sum.deliveryFee ?? 0) / totals._count.id) : 0,
        topCities:    byCity.map((c: any) => ({ city: c.deliveryCity, fees: c._sum.deliveryFee ?? 0, orders: c._count.id })),
        monthly:      Array.from(monthlyMap.entries()).map(([month, v]) => ({ month, ...v })),
      },
    };
  }

  async getTransactions(filters: any, pagination: PaginationDto) {
    const where: any = {};
    if (filters.type)   where.type   = filters.type;
    if (filters.status) where.status = filters.status;
    if (filters.from && filters.to) where.createdAt = { gte: new Date(filters.from), lte: new Date(filters.to) };
    if (filters.country) {
      where.OR = [
        { driver: { user: { countryCode: filters.country } } },
        { professional: { user: { countryCode: filters.country } } },
      ];
    }

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: {
          professional: { select: { businessName: true } },
          driver: { include: { user: { select: { name: true, phone: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit ?? 100,
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return { data: transactions, meta: { total, page: pagination.page, limit: pagination.limit } };
  }

  async updateTransactionStatus(id: string, status: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id } });
    if (!tx) throw new NotFoundException('Transaction introuvable.');
    return this.prisma.transaction.update({ where: { id }, data: { status: status as any } });
  }

  // ─── COMMISSION CONFIG ────────────────────
  async setCommissionConfig(dto: any) {
    // New format: { professional: { type, value }, driver: { type, value }, countries?: {...} }
    // Old format (backward compat): { type, value, perCategory }
    const data = dto.professional
      ? { professional: dto.professional, driver: dto.driver ?? { type: 'PERCENTAGE', value: 10 }, countries: dto.countries ?? {} }
      : { type: dto.type, value: dto.value, perCategory: dto.perCategory };
    return this.prisma.platformConfig.upsert({
      where: { key: 'commission' },
      update: { value: data },
      create: { key: 'commission', value: data },
    });
  }

  async setPaymentGateways(config: Record<string, boolean>) {
    return this.prisma.platformConfig.upsert({
      where: { key: 'paymentGateways' },
      update: { value: config },
      create: { key: 'paymentGateways', value: config },
    });
  }

  private maskSecret(value: string): string {
    if (!value || value.length <= 8) return '****';
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
  }

  async getPaymentCredentials() {
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentCredentials' } });
    const raw = (cfg?.value as any) ?? {};
    const masked: any = {};
    for (const [gateway, creds] of Object.entries(raw)) {
      masked[gateway] = {};
      for (const [field, value] of Object.entries(creds as any)) {
        if (field === 'sandbox' || typeof value !== 'string') {
          (masked[gateway] as any)[field] = value;
        } else {
          (masked[gateway] as any)[field] = value ? this.maskSecret(value) : '';
        }
      }
    }
    return { data: masked };
  }

  async setPaymentCredentials(credentials: Record<string, Record<string, any>>) {
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentCredentials' } });
    const existing: any = (cfg?.value as any) ?? {};
    const merged: any = {};
    for (const [gateway, creds] of Object.entries(credentials)) {
      merged[gateway] = { ...(existing[gateway] ?? {}) };
      for (const [field, value] of Object.entries(creds)) {
        if (value !== '__keep__') merged[gateway][field] = value;
      }
    }
    await this.prisma.platformConfig.upsert({
      where: { key: 'paymentCredentials' },
      update: { value: merged },
      create: { key: 'paymentCredentials', value: merged },
    });
    return { success: true };
  }

  // ─── PROMO CODES ──────────────────────────
  async getPromoCodes() {
    return this.prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        professional: { select: { id: true, businessName: true } },
        product: { select: { id: true, name: true } },
      },
    });
  }

  async createPromoCode(dto: any) {
    const { code, type, value, minOrder, maxUses, perUser, expiresAt, countries, professionalId, productId } = dto;
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
        professionalId: professionalId || null,
        productId: productId || null,
      },
      include: {
        professional: { select: { id: true, businessName: true } },
        product: { select: { id: true, name: true } },
      },
    });
  }

  async updatePromoCode(id: string, dto: any) {
    const { code, type, value, minOrder, maxUses, perUser, expiresAt, countries, professionalId, productId } = dto;
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
        ...(professionalId !== undefined && { professionalId: professionalId || null }),
        ...(productId !== undefined && { productId: productId || null }),
      },
      include: {
        professional: { select: { id: true, businessName: true } },
        product: { select: { id: true, name: true } },
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
    return this.prisma.deliveryZone.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async upsertDeliveryZone(dto: any) {
    const { id, name, country, fromCity, toCity, baseFee, perKmFee, currency, weatherMultiplier, isActive } = dto;
    const data = {
      name: name ?? '',
      country: country ?? 'BJ',
      fromCity: fromCity || null,
      toCity: toCity || null,
      baseFee: Number(baseFee ?? 0),
      perKmFee: Number(perKmFee ?? 0),
      currency: currency ?? 'XOF',
      weatherMultiplier: Number(weatherMultiplier ?? 1),
      isActive: isActive !== false,
    };
    if (id) return this.prisma.deliveryZone.update({ where: { id }, data });
    return this.prisma.deliveryZone.create({ data });
  }

  async deleteDeliveryZone(id: string) {
    await this.prisma.deliveryZone.delete({ where: { id } });
    return { success: true };
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
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const [referrals, total, pending, rewarded, totalCreditsAgg, topRaw, recent] = await Promise.all([
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
      this.prisma.referral.groupBy({
        by: ['referrerId'],
        _count: { id: true },
        where: { status: 'REWARDED' },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
      this.prisma.referral.findMany({
        where: { createdAt: { gte: sixMonthsAgo } },
        select: { createdAt: true, status: true },
      }),
    ]);

    // Top parrains enrichis
    const topIds = topRaw.map(r => r.referrerId);
    const [topUsers, topAllCounts] = topIds.length > 0 ? await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: topIds } }, select: { id: true, name: true, firstName: true, phone: true } }),
      this.prisma.referral.groupBy({ by: ['referrerId'], _count: { id: true }, where: { referrerId: { in: topIds } } }),
    ]) : [[], []];
    const userMap = new Map(topUsers.map(u => [u.id, u]));
    const allCountMap = new Map((topAllCounts as any[]).map(r => [r.referrerId, r._count.id]));
    const topReferrers = topRaw.map(r => ({
      user: userMap.get(r.referrerId),
      rewarded: r._count.id,
      total: allCountMap.get(r.referrerId) ?? r._count.id,
    }));

    // Tendance mensuelle (6 derniers mois)
    const monthlyMap = new Map<string, { created: number; rewarded: number }>();
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyMap.set(key, { created: 0, rewarded: 0 });
    }
    for (const r of recent) {
      const d = new Date(r.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthlyMap.has(key)) {
        const e = monthlyMap.get(key)!;
        e.created++;
        if (r.status === 'REWARDED') e.rewarded++;
      }
    }
    const monthly = Array.from(monthlyMap.entries()).map(([month, v]) => ({ month, ...v }));
    const conversionRate = total > 0 ? Math.round((rewarded / total) * 100) : 0;
    const totalCredits = totalCreditsAgg._sum.amount ?? 0;

    return { data: { referrals, stats: { total, pending, rewarded, totalCredits, conversionRate }, topReferrers, monthly } };
  }

  async getReferralLinks(limit = 100) {
    const users = await (this.prisma.user as any).findMany({
      where: { referralCode: { not: null } },
      select: { id: true, name: true, firstName: true, phone: true, referralCode: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    if (!users.length) return { data: [] };
    const ids = users.map((u: any) => u.id);
    const [totalCounts, rewardedCounts] = await Promise.all([
      this.prisma.referral.groupBy({ by: ['referrerId'], _count: { id: true }, where: { referrerId: { in: ids } } }),
      this.prisma.referral.groupBy({ by: ['referrerId'], _count: { id: true }, where: { referrerId: { in: ids }, status: 'REWARDED' } }),
    ]);
    const totalMap = new Map((totalCounts as any[]).map(r => [r.referrerId, r._count.id]));
    const rewardedMap = new Map((rewardedCounts as any[]).map(r => [r.referrerId, r._count.id]));
    return { data: users.map((u: any) => ({ ...u, totalReferrals: totalMap.get(u.id) ?? 0, rewardedReferrals: rewardedMap.get(u.id) ?? 0 })) };
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

  // ─── PAYS ─────────────────────────────────
  private readonly DEFAULT_COUNTRIES = [
    // Afrique de l'Ouest
    { code: 'BJ', name: 'Bénin',               emoji: '🇧🇯', currency: 'XOF' },
    { code: 'BF', name: 'Burkina Faso',         emoji: '🇧🇫', currency: 'XOF' },
    { code: 'CV', name: 'Cap-Vert',             emoji: '🇨🇻', currency: 'CVE' },
    { code: 'CI', name: "Côte d'Ivoire",        emoji: '🇨🇮', currency: 'XOF' },
    { code: 'GM', name: 'Gambie',               emoji: '🇬🇲', currency: 'GMD' },
    { code: 'GH', name: 'Ghana',                emoji: '🇬🇭', currency: 'GHS' },
    { code: 'GN', name: 'Guinée',               emoji: '🇬🇳', currency: 'GNF' },
    { code: 'GW', name: 'Guinée-Bissau',        emoji: '🇬🇼', currency: 'XOF' },
    { code: 'LR', name: 'Liberia',              emoji: '🇱🇷', currency: 'LRD' },
    { code: 'ML', name: 'Mali',                 emoji: '🇲🇱', currency: 'XOF' },
    { code: 'MR', name: 'Mauritanie',           emoji: '🇲🇷', currency: 'MRU' },
    { code: 'NE', name: 'Niger',                emoji: '🇳🇪', currency: 'XOF' },
    { code: 'NG', name: 'Nigeria',              emoji: '🇳🇬', currency: 'NGN' },
    { code: 'SN', name: 'Sénégal',              emoji: '🇸🇳', currency: 'XOF' },
    { code: 'SL', name: 'Sierra Leone',         emoji: '🇸🇱', currency: 'SLL' },
    { code: 'TG', name: 'Togo',                 emoji: '🇹🇬', currency: 'XOF' },
    // Afrique Centrale
    { code: 'AO', name: 'Angola',               emoji: '🇦🇴', currency: 'AOA' },
    { code: 'CF', name: 'Centrafrique',          emoji: '🇨🇫', currency: 'XAF' },
    { code: 'CM', name: 'Cameroun',             emoji: '🇨🇲', currency: 'XAF' },
    { code: 'CG', name: 'Congo',                emoji: '🇨🇬', currency: 'XAF' },
    { code: 'CD', name: 'RD Congo',             emoji: '🇨🇩', currency: 'CDF' },
    { code: 'GQ', name: 'Guinée équatoriale',   emoji: '🇬🇶', currency: 'XAF' },
    { code: 'GA', name: 'Gabon',                emoji: '🇬🇦', currency: 'XAF' },
    { code: 'ST', name: 'São Tomé-et-Príncipe', emoji: '🇸🇹', currency: 'STN' },
    { code: 'TD', name: 'Tchad',                emoji: '🇹🇩', currency: 'XAF' },
    // Afrique de l'Est
    { code: 'BI', name: 'Burundi',              emoji: '🇧🇮', currency: 'BIF' },
    { code: 'KM', name: 'Comores',              emoji: '🇰🇲', currency: 'KMF' },
    { code: 'DJ', name: 'Djibouti',             emoji: '🇩🇯', currency: 'DJF' },
    { code: 'ER', name: 'Érythrée',             emoji: '🇪🇷', currency: 'ERN' },
    { code: 'ET', name: 'Éthiopie',             emoji: '🇪🇹', currency: 'ETB' },
    { code: 'KE', name: 'Kenya',                emoji: '🇰🇪', currency: 'KES' },
    { code: 'MG', name: 'Madagascar',           emoji: '🇲🇬', currency: 'MGA' },
    { code: 'MW', name: 'Malawi',               emoji: '🇲🇼', currency: 'MWK' },
    { code: 'MU', name: 'Maurice',              emoji: '🇲🇺', currency: 'MUR' },
    { code: 'MZ', name: 'Mozambique',           emoji: '🇲🇿', currency: 'MZN' },
    { code: 'RW', name: 'Rwanda',               emoji: '🇷🇼', currency: 'RWF' },
    { code: 'SC', name: 'Seychelles',           emoji: '🇸🇨', currency: 'SCR' },
    { code: 'SO', name: 'Somalie',              emoji: '🇸🇴', currency: 'SOS' },
    { code: 'SS', name: 'Soudan du Sud',        emoji: '🇸🇸', currency: 'SSP' },
    { code: 'TZ', name: 'Tanzanie',             emoji: '🇹🇿', currency: 'TZS' },
    { code: 'UG', name: 'Ouganda',              emoji: '🇺🇬', currency: 'UGX' },
    { code: 'ZM', name: 'Zambie',               emoji: '🇿🇲', currency: 'ZMW' },
    { code: 'ZW', name: 'Zimbabwe',             emoji: '🇿🇼', currency: 'ZWL' },
    // Afrique du Nord
    { code: 'DZ', name: 'Algérie',              emoji: '🇩🇿', currency: 'DZD' },
    { code: 'EG', name: 'Égypte',               emoji: '🇪🇬', currency: 'EGP' },
    { code: 'LY', name: 'Libye',                emoji: '🇱🇾', currency: 'LYD' },
    { code: 'MA', name: 'Maroc',                emoji: '🇲🇦', currency: 'MAD' },
    { code: 'SD', name: 'Soudan',               emoji: '🇸🇩', currency: 'SDG' },
    { code: 'TN', name: 'Tunisie',              emoji: '🇹🇳', currency: 'TND' },
    // Afrique Australe
    { code: 'BW', name: 'Botswana',             emoji: '🇧🇼', currency: 'BWP' },
    { code: 'LS', name: 'Lesotho',              emoji: '🇱🇸', currency: 'LSL' },
    { code: 'NA', name: 'Namibie',              emoji: '🇳🇦', currency: 'NAD' },
    { code: 'ZA', name: 'Afrique du Sud',       emoji: '🇿🇦', currency: 'ZAR' },
    { code: 'SZ', name: 'Eswatini',             emoji: '🇸🇿', currency: 'SZL' },
    // Europe (diaspora)
    { code: 'BE', name: 'Belgique',             emoji: '🇧🇪', currency: 'EUR' },
    { code: 'CH', name: 'Suisse',               emoji: '🇨🇭', currency: 'CHF' },
    { code: 'DE', name: 'Allemagne',            emoji: '🇩🇪', currency: 'EUR' },
    { code: 'ES', name: 'Espagne',              emoji: '🇪🇸', currency: 'EUR' },
    { code: 'FR', name: 'France',               emoji: '🇫🇷', currency: 'EUR' },
    { code: 'GB', name: 'Royaume-Uni',          emoji: '🇬🇧', currency: 'GBP' },
    { code: 'IT', name: 'Italie',               emoji: '🇮🇹', currency: 'EUR' },
    { code: 'NL', name: 'Pays-Bas',             emoji: '🇳🇱', currency: 'EUR' },
    { code: 'PT', name: 'Portugal',             emoji: '🇵🇹', currency: 'EUR' },
    // Amériques (diaspora)
    { code: 'BR', name: 'Brésil',               emoji: '🇧🇷', currency: 'BRL' },
    { code: 'CA', name: 'Canada',               emoji: '🇨🇦', currency: 'CAD' },
    { code: 'US', name: 'États-Unis',           emoji: '🇺🇸', currency: 'USD' },
  ];

  async getCountries() {
    let countries = await (this.prisma as any).country.findMany({ orderBy: { name: 'asc' } });
    if (countries.length === 0) {
      await (this.prisma as any).country.createMany({ data: this.DEFAULT_COUNTRIES, skipDuplicates: true });
      countries = await (this.prisma as any).country.findMany({ orderBy: { name: 'asc' } });
    }
    return { data: countries };
  }

  async toggleCountry(code: string) {
    const country = await (this.prisma as any).country.findUnique({ where: { code } });
    if (!country) throw new NotFoundException('Pays introuvable');
    const updated = await (this.prisma as any).country.update({
      where: { code },
      data: { isActive: !country.isActive },
    });
    return { data: updated };
  }

  // ─── DEVISES ──────────────────────────────
  private readonly DEFAULT_CURRENCIES = [
    { fromCurrency: 'EUR', toCurrency: 'XOF', rate: 655.957 },
    { fromCurrency: 'USD', toCurrency: 'XOF', rate: 610.0   },
    { fromCurrency: 'GBP', toCurrency: 'XOF', rate: 780.0   },
    { fromCurrency: 'GHS', toCurrency: 'XOF', rate: 42.0    },
    { fromCurrency: 'NGN', toCurrency: 'XOF', rate: 0.38    },
    { fromCurrency: 'XAF', toCurrency: 'XOF', rate: 1.0     },
  ];

  async getCurrencies() {
    let rates = await this.prisma.exchangeRate.findMany({ where: { toCurrency: 'XOF' }, orderBy: { fromCurrency: 'asc' } });
    if (rates.length === 0) {
      await this.prisma.exchangeRate.createMany({ data: this.DEFAULT_CURRENCIES, skipDuplicates: true });
      rates = await this.prisma.exchangeRate.findMany({ where: { toCurrency: 'XOF' }, orderBy: { fromCurrency: 'asc' } });
    }
    return { data: { base: 'XOF', rates } };
  }

  async upsertCurrencies(entries: { fromCurrency: string; rate: number }[]) {
    await Promise.all(entries.map(e =>
      this.prisma.exchangeRate.upsert({
        where: { fromCurrency_toCurrency: { fromCurrency: e.fromCurrency, toCurrency: 'XOF' } },
        update: { rate: e.rate },
        create: { fromCurrency: e.fromCurrency, toCurrency: 'XOF', rate: e.rate },
      }),
    ));
    return this.getCurrencies();
  }

  // ─── COMPTES ADMIN ────────────────────────
  async getAdmins() {
    const users = await this.prisma.user.findMany({
      where: { role: 'ADMIN' as any },
      include: { admin: true },
      orderBy: { createdAt: 'desc' },
    });
    return { data: users };
  }

  async createAdminAccount(dto: { name: string; firstName?: string; email: string; phone: string; level: string; pin: string }) {
    const VALID_LEVELS = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'MODERATOR', 'ANALYST'];
    if (!VALID_LEVELS.includes(dto.level)) throw new BadRequestException('Niveau admin invalide');
    if (!/^\d{4,}$/.test(dto.pin)) throw new BadRequestException('Le PIN doit contenir au minimum 4 chiffres');
    const existing = await this.prisma.user.findFirst({ where: { OR: [{ email: dto.email }, { phone: dto.phone }] } });
    if (existing) throw new BadRequestException('Email ou téléphone déjà utilisé');
    const bcrypt = await import('bcrypt');
    const pinHash = await bcrypt.hash(dto.pin, 10);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        firstName: dto.firstName,
        email: dto.email,
        phone: dto.phone,
        pinHash,
        role: 'ADMIN' as any,
        status: 'ACTIVE' as any,
        createdByAdmin: true,
      } as any,
    });
    const admin = await this.prisma.admin.create({ data: { userId: user.id, level: dto.level as any } });
    return { data: { ...user, admin } };
  }

  async updateAdminAccount(id: string, dto: { name?: string; firstName?: string; email?: string; phone?: string; level?: string }) {
    const VALID_LEVELS = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'MODERATOR', 'ANALYST'];
    if (dto.level && !VALID_LEVELS.includes(dto.level)) throw new BadRequestException('Niveau admin invalide');
    const admin = await this.prisma.admin.findFirst({ where: { userId: id } });
    if (!admin) throw new NotFoundException('Compte admin introuvable');
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { name: dto.name, firstName: dto.firstName, email: dto.email, phone: dto.phone } as any,
      }),
      ...(dto.level ? [this.prisma.admin.update({ where: { userId: id }, data: { level: dto.level as any } })] : []),
    ]);
    return { data: user };
  }

  async toggleAdminStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== ('ADMIN' as any)) throw new NotFoundException('Compte admin introuvable');
    return this.prisma.user.update({ where: { id }, data: { status: status as any } });
  }

  async deleteAdminAccount(id: string) {
    const admin = await this.prisma.admin.findFirst({ where: { userId: id } });
    if (!admin) throw new NotFoundException('Compte admin introuvable');
    await this.prisma.$transaction([
      this.prisma.admin.delete({ where: { userId: id } }),
      this.prisma.user.delete({ where: { id } }),
    ]);
    return { data: { deleted: true } };
  }
}
