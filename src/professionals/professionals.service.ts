import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { UploadsService } from '../uploads/uploads.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateProfessionalDto, UpdateProfessionalDto, UpdateOpeningHoursDto } from './dto/professional.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class ProfessionalsService {
  private readonly logger = new Logger(ProfessionalsService.name);
  constructor(
    private prisma: PrismaService,
    private uploads: UploadsService,
    private notifications: NotificationsService,
  ) {}

  async register(userId: string, dto: CreateProfessionalDto) {
    const existing = await this.prisma.professional.findUnique({ where: { userId } });
    if (existing) throw new ConflictException('Professional profile already exists');

    return this.prisma.professional.create({
      data: { ...dto, userId, category: dto.category as any, status: 'PENDING' },
    });
  }

  async getMyProfile(userId: string) {
    // Upsert (idempotent) : si le user vient juste de finir l'OTP+PIN avec
    // role=PROFESSIONAL et n'a pas encore complété /professionals/register,
    // on lui crée un record placeholder. Ça permet à toute l'app pro
    // (dashboard, toggleOpen, schedule, etc.) de fonctionner immédiatement
    // au lieu de 404. L'utilisateur complétera ses infos via 'Modifier mes
    // informations'. Catégorie/pays par défaut = RESTAURANT/BJ.
    const prof = await this.prisma.professional.upsert({
      where:  { userId },
      update: {},
      create: {
        userId,
        businessName: 'Mon établissement',
        category:     'RESTAURANT',
        address:      '',
        city:         '',
        country:      'BJ',
        lat:          0,
        lng:          0,
        status:       'PENDING',
        deliveryRadiusKm: 10,
      },
      include: { documents: true },
    });
    // Override isOpen avec l'auto-calcul si des horaires sont configurés.
    // Source de vérité = openingHours + heure courante (Bénin/Cotonou UTC+1).
    return { data: { ...prof, isOpen: this._computeIsOpen(prof.isOpen, prof.openingHours) } };
  }

  /// Détermine si l'établissement est ouvert à l'instant T.
  /// - Si openingHours non configuré -> on respecte le toggle manuel `dbIsOpen`
  /// - Sinon : ouvert UNIQUEMENT si on est dans la plage du jour courant
  ///
  /// Heure de référence : Africa/Porto-Novo (UTC+1, pas de DST au Bénin).
  /// Format des slots : `{mon: {open: '08:00', close: '22:00'}, ...}`.
  /// Une valeur null/absente sur un jour = fermé ce jour.
  /// Slot qui passe minuit (ex: open=22:00, close=02:00) = supporté.
  private _computeIsOpen(dbIsOpen: boolean, openingHours: any): boolean {
    if (!openingHours || typeof openingHours !== 'object' || Object.keys(openingHours).length === 0) {
      return dbIsOpen;
    }
    // Heure courante au fuseau Bénin (UTC+1).
    const now = new Date();
    const benin = new Date(now.getTime() + 1 * 60 * 60 * 1000); // +1h offset UTC
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const todayKey = dayKeys[benin.getUTCDay()];
    const yesterdayKey = dayKeys[(benin.getUTCDay() + 6) % 7];

    const nowMinutes = benin.getUTCHours() * 60 + benin.getUTCMinutes();

    const parseSlot = (slot: any): [number, number] | null => {
      if (!slot || typeof slot !== 'object') return null;
      const open  = typeof slot.open  === 'string' ? slot.open  : null;
      const close = typeof slot.close === 'string' ? slot.close : null;
      if (!open || !close) return null;
      const [oh, om] = open.split(':').map(Number);
      const [ch, cm] = close.split(':').map(Number);
      if ([oh, om, ch, cm].some((n) => Number.isNaN(n))) return null;
      return [oh * 60 + om, ch * 60 + cm];
    };

    // Cas 1 : slot du jour courant
    const today = parseSlot(openingHours[todayKey]);
    if (today) {
      const [open, close] = today;
      if (close > open) {
        // Slot classique 08:00-22:00
        if (nowMinutes >= open && nowMinutes < close) return true;
      } else if (close < open) {
        // Slot qui passe minuit (ex: 22:00-02:00) -> ouvert si >= open
        if (nowMinutes >= open) return true;
      }
    }
    // Cas 2 : slot d'hier qui passe minuit et qu'on est encore dedans
    const yesterday = parseSlot(openingHours[yesterdayKey]);
    if (yesterday) {
      const [open, close] = yesterday;
      if (close < open && nowMinutes < close) return true;
    }
    return false;
  }

  async updateProfile(userId: string, dto: UpdateProfessionalDto) {
    // UPSERT au lieu de UPDATE strict.
    //
    // Contexte : le flow auth (OTP+PIN) crée un User avec role=PROFESSIONAL
    // MAIS ne crée PAS automatiquement un record Professional associé
    // (le endpoint /professionals/register n'est jamais appelé en pratique).
    // Du coup, le 1er PATCH /professionals/me retournait 404 et empêchait
    // l'utilisateur de remplir son profil métier.
    //
    // Maintenant : si pas de record -> on le crée avec les valeurs envoyées
    // + des defaults pour les champs Prisma required (category/address/city/
    // country/lat/lng/businessName). L'utilisateur complète ensuite via
    // l'écran 'Modifier mes informations'.
    return this.prisma.professional.upsert({
      where:  { userId },
      update: { ...dto },
      create: {
        userId,
        businessName: dto.businessName ?? 'Mon établissement',
        category:     'RESTAURANT', // catégorie par défaut, éditable plus tard
        address:      dto.address ?? '',
        city:         dto.city    ?? '',
        country:      'BJ',  // Bénin par défaut, à généraliser si multi-pays
        lat:          dto.lat ?? 0,
        lng:          dto.lng ?? 0,
        status:       'PENDING',
        description:  dto.description,
        phone:        dto.phone,
        email:        dto.email,
        deliveryRadiusKm: dto.deliveryRadiusKm ?? 10,
      },
    });
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
    // Requête principale sans produits (évite une dépendance à la relation
    // Prisma qui peut être désynchronisée après db push partiel).
    const prof = await this.prisma.professional.findUnique({
      where: { id, status: 'VALIDATED' },
      include: {
        // Catégories du pro pour le groupement dans le menu
        productCategories: { orderBy: { sortOrder: 'asc' } },
        reviews: {
          include: { reviewer: { select: { name: true, avatarUrl: true } } },
          take: 10,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!prof) throw new NotFoundException('Establishment not found');

    // Chargement des produits via findMany explicite — indépendant de la
    // relation Prisma. Inclut toutes les catégories (globales + pro-spécifiques)
    // pour que les produits créés depuis l'admin (catégories globales) soient
    // bien retournés. C'est plus robuste que `include: { products }` sur le
    // findUnique ci-dessus qui peut rater les produits sous catégories globales
    // si la relation Prisma est désynchronisée.
    const products = await this.prisma.product.findMany({
      where: { professionalId: id },
      include: { category: true },
      orderBy: [{ categoryId: 'asc' }, { createdAt: 'asc' }],
    });

    this.logger.log(`getPublicProfile id=${id} → ${products.length} produit(s) trouvé(s)`);

    // ── Sanitisation variants/options ───────────────────────────────────────
    // En BDD certains produits ont des `variants` et `options` stockés sous la
    // forme [[]] (liste de listes vides) au lieu de [{…}] — saisie admin
    // malformée. Côté mobile, le parser Product.fromJson Dart fait
    // `Map<String, dynamic>.from(e)` sur chaque élément ; appliqué à une List,
    // ça lève une exception non catchée et casse l'affichage du menu entier.
    // On filtre ici pour ne garder que les vrais objets (non-null, non-array).
    const sanitizedProducts = products.map((p) => {
      const cleanArr = (raw: any) =>
        Array.isArray(raw)
          ? raw.filter((v) => v != null && typeof v === 'object' && !Array.isArray(v))
          : raw;
      return {
        ...p,
        variants: cleanArr((p as any).variants),
        options:  cleanArr((p as any).options),
      };
    });

    // Catégories référencées par les produits mais absentes de productCategories
    // (catégories globales, professionalId = null, créées depuis l'admin).
    // On les charge séparément et on les fusionne pour que le mobile puisse
    // afficher les labels corrects dans le sélecteur de catégories.
    const proSpecificCatIds = new Set(prof.productCategories.map((c: any) => c.id));
    const globalCatIds = [...new Set(
      products
        .map((p) => p.categoryId)
        .filter((catId): catId is string => !!catId && !proSpecificCatIds.has(catId))
    )];

    const globalCategories = globalCatIds.length > 0
      ? await this.prisma.productCategory.findMany({
          where: { id: { in: globalCatIds } },
          orderBy: { sortOrder: 'asc' },
        })
      : [];

    const allCategories = [...prof.productCategories, ...globalCategories]
      .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    // Note moyenne + nombre total de reviews (requêtes séparées car _count
    // dans findUnique n'est pas typé correctement par Prisma TS generator).
    const [ratingAgg, reviewCount] = await Promise.all([
      this.prisma.review.aggregate({
        where: { professionalId: id },
        _avg: { professionalRating: true },
      }),
      this.prisma.review.count({ where: { professionalId: id } }),
    ]);
    const avgRating = ratingAgg._avg.professionalRating ?? 0;

    // Délai de livraison moyen depuis la config plateforme, sinon valeur par défaut.
    const deliveryConfig = await this.prisma.platformConfig.findUnique({ where: { key: 'delivery' } });
    const deliveryDefaults = (deliveryConfig?.value as any) ?? {};

    return {
      data: {
        ...prof,
        // Produits chargés explicitement (voir commentaire ci-dessus)
        products: sanitizedProducts,
        // Catégories fusionnées : pro-spécifiques + globales utilisées par les produits
        productCategories: allCategories,
        // Champs aplatis pour le mobile
        avgRating: Math.round(avgRating * 10) / 10,
        reviewCount,
        deliveryTimeMin: deliveryDefaults.defaultTimeMin ?? 25,
        // deliveryFee volontairement absent : la valeur réelle est calculée dynamiquement
        // par geo.service.calculateDeliveryFee() selon le mode actif (zone/km/city).
        // BUG FIX : recalculer isOpen avec les horaires configurés, exactement
        // comme getMyProfile le fait. Sans ça, le client voyait le isOpen brut
        // de la DB (souvent false) même si les openingHours indiquaient ouvert.
        isOpen: this._computeIsOpen(prof.isOpen, prof.openingHours),
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
    // If driver was private for this pro, remove that link too.
    await this.prisma.driver.updateMany({
      where: { id: driverId, privateForProfessionalId: prof.id },
      data:  { isPrivate: false, privateForProfessionalId: null },
    });
    return this.prisma.professionalFavoriteDriver.delete({
      where: { professionalId_driverId: { professionalId: prof.id, driverId } },
    });
  }

  async markDriverPrivate(userId: string, driverId: string, isPrivate: boolean) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    // Must already be a favorite.
    const fav = await this.prisma.professionalFavoriteDriver.findUnique({
      where: { professionalId_driverId: { professionalId: prof.id, driverId } },
    });
    if (!fav) throw new BadRequestException('Driver is not in your favorites');
    if (isPrivate) {
      // Check driver is not already private for another pro.
      const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
      if (driver?.isPrivate && driver.privateForProfessionalId !== prof.id) {
        throw new ConflictException('Driver is already private for another professional');
      }
      return this.prisma.driver.update({
        where: { id: driverId },
        data:  { isPrivate: true, privateForProfessionalId: prof.id },
        select: { id: true, isPrivate: true, privateForProfessionalId: true },
      });
    } else {
      return this.prisma.driver.update({
        where: { id: driverId },
        data:  { isPrivate: false, privateForProfessionalId: null },
        select: { id: true, isPrivate: true, privateForProfessionalId: true },
      });
    }
  }

  async searchDriverByPhone(userId: string, phone: string) {
    if (!phone || phone.trim().length < 8) {
      throw new BadRequestException('Phone number too short');
    }
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException('Professional profile not found');

    const digits = phone.trim().replace(/\D/g, '');
    const user = await this.prisma.user.findFirst({
      where: { phone: { contains: digits }, role: 'DRIVER' },
      select: {
        id: true, name: true, firstName: true, avatarUrl: true, phone: true,
        driver: {
          select: {
            id: true, vehicleType: true, licensePlate: true,
            status: true, isAvailable: true, isPrivate: true, privateForProfessionalId: true,
          },
        },
      },
    });
    if (!user || !user.driver) throw new NotFoundException('Livreur introuvable');

    const alreadyFavorite = await this.prisma.professionalFavoriteDriver.findUnique({
      where: { professionalId_driverId: { professionalId: prof.id, driverId: user.driver.id } },
      select: { driverId: true },
    });

    return {
      data: {
        ...user.driver,
        user: { name: user.name, firstName: user.firstName, avatarUrl: user.avatarUrl, phone: user.phone },
        alreadyFavorite: !!alreadyFavorite,
      },
    };
  }

  // ── Promo codes (pro-side) ────────────────────────────────────────────────

  // Ajoute les alias mobile (discountType/discountValue/minOrderAmount) sur un
  // objet PromoCode issu de Prisma (qui stocke type/value/minOrder).
  // L'admin utilise les noms Prisma → on conserve les deux dans la réponse.
  private _promoWithAliases(c: any) {
    return { ...c, discountType: c.type, discountValue: c.value, minOrderAmount: c.minOrder };
  }

  async listPromoCodes(userId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    const codes = await this.prisma.promoCode.findMany({
      where: { professionalId: prof.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data: codes.map(c => this._promoWithAliases(c)) };
  }

  async createPromoCode(userId: string, dto: any) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    const code = (dto.code as string)?.toUpperCase().trim();
    if (!code) throw new BadRequestException('Code requis');
    const existing = await this.prisma.promoCode.findUnique({ where: { code } });
    if (existing) throw new ConflictException('Ce code existe déjà');
    // Accepte les deux conventions : admin envoie type/value/minOrder,
    // mobile envoie discountType/discountValue/minOrderAmount.
    const created = await this.prisma.promoCode.create({
      data: {
        code,
        type:           dto.discountType  ?? dto.type     ?? 'PERCENTAGE',
        value:          Number(dto.discountValue  ?? dto.value)    || 0,
        minOrder:       Number(dto.minOrderAmount ?? dto.minOrder) || 0,
        maxUses:        dto.maxUses ? Number(dto.maxUses) : null,
        perUser:        dto.perUser  ?? false,
        expiresAt:      dto.expiresAt ? new Date(dto.expiresAt) : null,
        countries:      dto.countries ?? ['BJ'],
        isActive:       dto.isActive ?? true,
        professionalId: prof.id,
      },
    });
    return { data: this._promoWithAliases(created) };
  }

  async updatePromoCode(userId: string, promoId: string, dto: any) {
    const prof  = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    const promo = await this.prisma.promoCode.findUnique({ where: { id: promoId } });
    if (!promo || promo.professionalId !== prof.id) throw new ForbiddenException();
    const patch: any = {};
    if (dto.isActive  !== undefined) patch.isActive  = dto.isActive;
    // Accepte les deux conventions de nommage (admin vs mobile).
    const rawValue = dto.discountValue ?? dto.value;
    const rawMin   = dto.minOrderAmount ?? dto.minOrder;
    if (rawValue !== undefined) patch.value    = Number(rawValue);
    if (rawMin   !== undefined) patch.minOrder = Number(rawMin);
    if (dto.maxUses   !== undefined) patch.maxUses   = dto.maxUses ? Number(dto.maxUses) : null;
    if (dto.expiresAt !== undefined) patch.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (dto.perUser   !== undefined) patch.perUser   = dto.perUser;
    const updated = await this.prisma.promoCode.update({ where: { id: promoId }, data: patch });
    return { data: this._promoWithAliases(updated) };
  }

  async deletePromoCode(userId: string, promoId: string) {
    const prof  = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    const promo = await this.prisma.promoCode.findUnique({ where: { id: promoId } });
    if (!promo || promo.professionalId !== prof.id) throw new ForbiddenException();
    await this.prisma.promoCode.delete({ where: { id: promoId } });
    return { data: { deleted: true } };
  }

  async getDashboard(userId: string) {
    // Pas de upsert ici (le faire dans getMyProfile/updateProfile suffit) :
    // si l'utilisateur n'a vraiment aucun record pro, on retourne des stats
    // vides plutôt qu'une 404 qui casserait l'écran dashboard mobile.
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) {
      return {
        data: {
          revenue: { today: 0, week: 0, month: 0 },
          orders:  { today: 0, pending: 0, total: 0 },
          avgRating: 0, reviewCount: 0,
          revenueByDay: [],
          topProducts:  [],
          recentReviews: [],
        },
      };
    }

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

    // Alias `comment` pour le mobile — même raison que getProfessionalReviews.
    const recentReviewsMapped = recentReviews.map(r => ({ ...r, comment: r.professionalComment }));

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
        avgRating: ratingAgg._avg.professionalRating
            ? Number(ratingAgg._avg.professionalRating.toFixed(1))
            : 0,
        reviewCount: ratingAgg._count,
        revenueByDay,
        topProducts,
        recentReviews: recentReviewsMapped,
      },
    };
  }

  // ── Demande de virement ────────────────────────────────────────────────────
  async requestWithdrawal(userId: string, amount: number, paymentInfo?: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    if (amount <= 0) throw new BadRequestException('Le montant doit être supérieur à 0');

    // Recalcule le solde disponible en temps réel (all-time net − virements)
    const [earningsAgg, paidOutAgg, pendingAgg] = await Promise.all([
      this.prisma.order.aggregate({
        where: { professionalId: prof.id, status: 'DELIVERED' },
        _sum: { subtotal: true, commissionAmount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { professionalId: prof.id, type: 'WITHDRAWAL' as any, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { professionalId: prof.id, type: 'WITHDRAWAL' as any, status: 'PENDING' },
        _sum: { amount: true },
      }),
    ]);

    const totalNet  = Number(earningsAgg._sum.subtotal ?? 0) - Number(earningsAgg._sum.commissionAmount ?? 0);
    const available = Math.max(0, totalNet - (paidOutAgg._sum.amount ?? 0) - (pendingAgg._sum.amount ?? 0));

    if (amount > available) {
      throw new BadRequestException(
        `Montant supérieur au solde disponible (${available.toFixed(0)} F)`
      );
    }

    const withdrawal = await this.prisma.transaction.create({
      data: {
        professionalId: prof.id,
        type:        'WITHDRAWAL' as any,
        amount,
        currency:    'XOF',
        status:      'PENDING',
        description: paymentInfo
          ? `Demande de virement — ${new Date().toLocaleDateString('fr-FR')} — Paiement : ${paymentInfo}`
          : `Demande de virement — ${new Date().toLocaleDateString('fr-FR')}`,
      },
    });

    // Notification aux admins (in-app + email) — best-effort
    this.notifications.notifyAdminsWithdrawalRequest({
      entityName:    prof.businessName ?? 'Établissement',
      entityType:    'professional',
      amount,
      currency:      'XOF',
      paymentInfo,
      transactionId: withdrawal.id,
    }).catch((e) => this.logger.warn(`notifyAdminsWithdrawalRequest pro: ${e?.message}`));

    return { data: withdrawal };
  }

  // ── Revenus détaillés ──────────────────────────────────────────────────────
  async getEarnings(userId: string, days: number) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) return { data: { commissionRate: 15, availableBalance: 0, pendingPayouts: 0, summary: { today: {gross:0,net:0}, week: {gross:0,net:0}, month: {gross:0,net:0} }, totals: { gross:0, commission:0, net:0, orders:0 }, revenueByDay: [], recentOrders: [] } };

    // Commission rate depuis PlatformConfig
    const commCfg = await this.prisma.platformConfig.findUnique({ where: { key: 'commission' } });
    const commRaw = commCfg?.value && typeof commCfg.value === 'object' ? (commCfg.value as any) : {};
    // Si les paliers RPO sont configurés, pas de taux unique à afficher (bannière masquée côté mobile)
    const hasTiers = Array.isArray(commRaw.professional?.tiers) &&
      commRaw.professional.tiers.some((t: any) => Number(t?.rate ?? 0) > 0 || Number(t?.fixedAmount ?? 0) > 0);
    const proPct  = hasTiers ? 0 : (commRaw.professional?.value ?? commRaw.value ?? 15);

    const now   = new Date();
    const today = new Date(now); today.setHours(0,0,0,0);
    const periodStart = new Date(today); periodStart.setDate(periodStart.getDate() - (days - 1));
    const weekAgo  = new Date(today); weekAgo.setDate(weekAgo.getDate() - 6);
    const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 29);

    // Construit les jours du calendrier oldest → newest
    const dayList: Date[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      dayList.push(d);
    }

    // ── Solde disponible (all-time) ────────────────────────────────────────
    const [allTimeAgg, withdrawalCompletedAgg, withdrawalPendingAgg] = await Promise.all([
      this.prisma.order.aggregate({
        where: { professionalId: prof.id, status: 'DELIVERED' },
        _sum: { subtotal: true, commissionAmount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { professionalId: prof.id, type: 'WITHDRAWAL' as any, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { professionalId: prof.id, type: 'WITHDRAWAL' as any, status: 'PENDING' },
        _sum: { amount: true },
      }),
    ]);
    const allTimeNet      = Number(allTimeAgg._sum.subtotal ?? 0) - Number(allTimeAgg._sum.commissionAmount ?? 0);
    const totalWithdrawn  = withdrawalCompletedAgg._sum.amount ?? 0;
    const pendingPayouts  = withdrawalPendingAgg._sum.amount   ?? 0;
    const availableBalance = Math.max(0, allTimeNet - totalWithdrawn - pendingPayouts);

    // Un aggregate par jour (subtotal + commissionAmount)
    const dayAggs = await Promise.all(
      dayList.map((dayStart) => {
        const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
        return this.prisma.order.aggregate({
          where: { professionalId: prof.id, status: 'DELIVERED', createdAt: { gte: dayStart, lt: dayEnd } },
          _sum: { subtotal: true, commissionAmount: true },
          _count: true,
        });
      }),
    );

    const revenueByDay = dayList.map((d, i) => {
      const gross      = Number(dayAggs[i]._sum.subtotal       ?? 0);
      const commission = Number(dayAggs[i]._sum.commissionAmount ?? 0);
      return { date: d.toISOString().substring(0,10), gross, commission, net: gross - commission, orders: dayAggs[i]._count };
    });

    // Totaux période
    const periodAgg = await this.prisma.order.aggregate({
      where: { professionalId: prof.id, status: 'DELIVERED', createdAt: { gte: periodStart } },
      _sum: { subtotal: true, commissionAmount: true }, _count: true,
    });
    const periodGross = Number(periodAgg._sum.subtotal ?? 0);
    const periodComm  = Number(periodAgg._sum.commissionAmount ?? 0);

    // Résumé fixe today / week / month
    const [todayAgg, weekAgg, monthAgg] = await Promise.all([
      this.prisma.order.aggregate({ where: { professionalId: prof.id, status: 'DELIVERED', createdAt: { gte: today } }, _sum: { subtotal: true, commissionAmount: true } }),
      this.prisma.order.aggregate({ where: { professionalId: prof.id, status: 'DELIVERED', createdAt: { gte: weekAgo } }, _sum: { subtotal: true, commissionAmount: true } }),
      this.prisma.order.aggregate({ where: { professionalId: prof.id, status: 'DELIVERED', createdAt: { gte: monthAgo } }, _sum: { subtotal: true, commissionAmount: true } }),
    ]);

    const _ns = (agg: any) => {
      const g = Number(agg._sum.subtotal ?? 0);
      const c = Number(agg._sum.commissionAmount ?? 0);
      return { gross: g, net: g - c };
    };

    // Dernières commandes livrées
    const recentRaw = await this.prisma.order.findMany({
      where: { professionalId: prof.id, status: 'DELIVERED' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, createdAt: true, subtotal: true, commissionAmount: true, totalAmount: true, _count: { select: { items: true } } },
    });
    const recentOrders = recentRaw.map(o => ({
      id:               o.id,
      createdAt:        o.createdAt,
      subtotal:         Number(o.subtotal),
      commissionAmount: Number(o.commissionAmount),
      netRevenue:       Number(o.subtotal) - Number(o.commissionAmount),
      total:            Number(o.totalAmount),
      itemCount:        o._count.items,
    }));

    return {
      data: {
        commissionRate: proPct,
        availableBalance,
        pendingPayouts,
        summary: {
          today: _ns(todayAgg),
          week:  _ns(weekAgg),
          month: _ns(monthAgg),
        },
        totals: {
          gross:      periodGross,
          commission: periodComm,
          net:        periodGross - periodComm,
          orders:     periodAgg._count,
        },
        revenueByDay,
        recentOrders,
      },
    };
  }

  // ── Documents ──────────────────────────────────────────────────────────────
  async getDocuments(userId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    const docs = await this.prisma.document.findMany({
      where: { professionalId: prof.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data: docs };
  }

  async getReviews(userId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    const reviews = await this.prisma.review.findMany({
      where: { professionalId: prof.id, isModerated: false },
      include: { reviewer: { select: { name: true, firstName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const avg = reviews.length
      ? reviews.reduce((s, r) => s + (r.professionalRating ?? 0), 0) / reviews.length
      : 0;
    const mapped = reviews.map(r => ({ ...r, comment: r.professionalComment }));
    return { data: { reviews: mapped, average: Math.round(avg * 10) / 10, count: reviews.length } };
  }

  async uploadDocument(userId: string, file: Express.Multer.File, docType: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId } });
    if (!prof) throw new NotFoundException();
    // Remplace le document existant du même type (un seul par type)
    await this.prisma.document.deleteMany({ where: { professionalId: prof.id, type: docType } });
    const url = await this.uploads.uploadFile(file, 'ife-food/documents/professional');
    const doc = await this.prisma.document.create({ data: { professionalId: prof.id, type: docType, url } });
    return { data: doc };
  }
}
