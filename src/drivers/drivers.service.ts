import { Injectable, NotFoundException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DeliveriesGateway } from '../deliveries/deliveries.gateway';
import { UploadsService } from '../uploads/uploads.service';
import { CreateDriverDto, UpdateDriverDto, UpdateLocationDto, SelectDriverZoneDto } from './dto/driver.dto';

// Limite max de missions actives en parallèle par driver.
// Aligné sur la valeur par défaut côté mobile (Driver.maxConcurrentDeliveries=3).
// À transformer en config admin (PlatformConfig) quand on aura besoin de la
// faire varier par driver ou par zone.
/** Capacités par défaut si PlatformConfig key='vehicle_capacity' absent. */
const DEFAULT_VEHICLE_CAPACITIES: Record<string, number> = {
  BICYCLE:    2,
  MOTORCYCLE: 5,
  CAR:        10,
  ON_FOOT:    1,
};

@Injectable()
export class DriversService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private deliveriesGateway: DeliveriesGateway,
    private uploads: UploadsService,
  ) {}

  async register(userId: string, dto: CreateDriverDto) {
    const created = await this.prisma.driver.create({
      data: { ...dto, userId, vehicleType: dto.vehicleType as any, status: 'PENDING' },
    });
    return { data: created };
  }

  async getMyProfile(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId }, include: { documents: true } });
    if (!driver) throw new NotFoundException('Driver profile not found');
    return { data: driver };
  }

  async updateProfile(userId: string, dto: UpdateDriverDto) {
    const updated = await this.prisma.driver.update({ where: { userId }, data: dto as any });
    return { data: updated };
  }

  async toggleAvailability(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();
    // Refuse de passer ONLINE si le compte n'est pas encore VALIDATED.
    // Avant : on bypassait cette check et le driver ONLINE pending
    // pouvait recevoir des missions sans validation admin.
    if (driver.status === 'PENDING' && !driver.isAvailable) {
      throw new ForbiddenException(
        'Votre compte doit être validé par l\'admin avant de passer en ligne');
    }
    const newStatus = driver.isAvailable ? 'OFFLINE' : 'ONLINE';
    const updated = await this.prisma.driver.update({
      where: { userId },
      data: { isAvailable: !driver.isAvailable, status: newStatus as any },
    });
    // Wrap dans { data } pour matcher le contrat des autres endpoints
    // (le mobile parse res['data'] → sans wrap, Driver.fromJson crashe
    // sur undefined et l'option ONLINE/OFFLINE ne marche pas).
    return { data: updated };
  }

  async updateLocation(userId: string, dto: UpdateLocationDto) {
    try {
      const updated = await this.prisma.driver.update({
        where: { userId },
        data: { currentLat: dto.lat, currentLng: dto.lng },
      });
      return { data: updated };
    } catch (e: any) {
      // P2025 = record not found : profil driver absent, on ignore silencieusement.
      if (e?.code === 'P2025') return { data: null };
      throw e;
    }
  }

  async getAvailableDrivers(lat: number, lng: number, radiusKm: number = 5) {
    const drivers = await this.prisma.driver.findMany({
      where: { isAvailable: true, status: 'ONLINE' },
      include: { user: { select: { name: true, firstName: true, avatarUrl: true, fcmToken: true } } },
    });

    const toRad = (d: number) => d * Math.PI / 180;
    const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
      const dLat = toRad(lat2 - lat1); const dLon = toRad(lng2 - lng1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    return drivers
      .filter((d) => d.currentLat && d.currentLng && haversine(lat, lng, d.currentLat, d.currentLng) <= radiusKm)
      .sort((a, b) => haversine(lat, lng, a.currentLat!, a.currentLng!) - haversine(lat, lng, b.currentLat!, b.currentLng!));
  }

  async acceptMission(userId: string, orderId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    // Quota par type de véhicule depuis PlatformConfig (défauts : vélo=2, moto=5, voiture=10).
    const capConfig = await this.prisma.platformConfig.findUnique({ where: { key: 'vehicle_capacity' } });
    const capacities: Record<string, number> = {
      ...DEFAULT_VEHICLE_CAPACITIES,
      ...(capConfig?.value as any ?? {}),
    };
    const maxCap = capacities[driver.vehicleType as string] ?? 3;

    const activeCount = await this.prisma.delivery.count({
      where: {
        driverId: driver.id,
        status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] as any },
      },
    });
    if (activeCount >= maxCap) {
      throw new ConflictException(
        `Quota atteint (${maxCap} missions actives max pour votre véhicule)`);
    }

    // Race condition fix : on encapsule dans une transaction et on catch
    // l'erreur Prisma P2002 (unique constraint sur orderId dans Delivery)
    // pour la convertir en ConflictException 409 propre. Avant : 2 drivers
    // qui acceptent en parallèle -> le 2e crashait sur P2002 brut côté CI.
    try {
      await this.prisma.$transaction(async (tx) => {
        // L'order doit être en statut READY_FOR_PICKUP (ou ACCEPTED si on
        // tolère une assignation anticipée). Bloque si déjà assigné.
        const order = await tx.order.findUnique({
          where: { id: orderId }, select: { status: true, driverId: true },
        });
        if (!order) throw new NotFoundException('Order not found');
        if (order.driverId) {
          throw new ConflictException('Mission already taken by another driver');
        }
        // Statuts autorisés pour acceptance par le driver. On reste large
        // (PAID inclus) pour ne pas casser le mode test PAYMENT_AUTO_CONFIRM
        // qui n'a pas forcément encore atteint READY_FOR_PICKUP.
        const acceptable = ['PAID', 'ACCEPTED', 'IN_PREPARATION', 'READY_FOR_PICKUP'];
        if (!acceptable.includes(order.status)) {
          throw new ConflictException(`Cannot accept mission in status ${order.status}`);
        }

        await tx.order.update({
          where: { id: orderId },
          data: { driverId: driver.id, status: 'DRIVER_ASSIGNED' as any },
        });
        await tx.delivery.create({ data: { orderId, driverId: driver.id } });
      });
    } catch (e: any) {
      // Prisma unique violation sur Delivery.orderId -> 409 propre.
      if (e?.code === 'P2002') {
        throw new ConflictException('Mission already taken by another driver');
      }
      throw e;
    }

    // Clé alignée sur statusMessages dans notifications.service.ts.
    // Sans cet appel, le client ne serait jamais notifié de l'assignation.
    await this.notifications.sendOrderNotification(orderId, 'DRIVER_ASSIGNED');

    // Sprint C - emit order_status temps réel + payload driver info pour
    // que le tracking_screen client se mette à jour immédiatement (nom +
    // tel du livreur dans la card "votre livreur" sans pull-to-refresh).
    const driverWithUser = await this.prisma.driver.findUnique({
      where: { id: driver.id },
      include: { user: { select: { name: true, firstName: true, phone: true, avatarUrl: true } } },
    });
    this.deliveriesGateway.emitOrderStatus(orderId, 'DRIVER_ASSIGNED', {
      driverName: driverWithUser?.user
        ? [driverWithUser.user.firstName, driverWithUser.user.name].filter(Boolean).join(' ')
        : null,
      driverPhone: driverWithUser?.user?.phone,
      driverAvatarUrl: driverWithUser?.user?.avatarUrl,
    });
    return { success: true };
  }

  async updateDeliveryStatus(
    userId: string, orderId: string, status: string,
    confirmPhoto?: string, confirmCode?: string,
  ) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    const delivery = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (!delivery) throw new NotFoundException('Delivery not found');
    if (delivery.driverId !== driver.id) throw new ForbiddenException();

    // Validation du code de confirmation client (si la feature est activée par l'admin).
    if (status === 'DELIVERED') {
      const confirmCfg = await this.prisma.platformConfig.findUnique({
        where: { key: 'delivery_confirm_code' },
      });
      const codeEnabled = (confirmCfg?.value as any)?.enabled ?? false;
      if (codeEnabled) {
        const order = await this.prisma.order.findUnique({
          where: { id: orderId }, select: { deliveryCode: true } as any,
        }) as any;
        if (!order?.deliveryCode || confirmCode !== order.deliveryCode) {
          throw new BadRequestException('Code de confirmation invalide');
        }
      }
    }

    await this.prisma.delivery.update({
      where: { orderId },
      data: {
        status: status as any,
        ...(confirmPhoto && { confirmPhoto }),
        ...(status === 'DELIVERED' && { deliveredTime: new Date() }),
        ...(status === 'PICKED_UP' && { pickupTime: new Date() }),
      },
    });

    if (status === 'DELIVERED') {
      await this.prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' as any } });
      await this.creditAfterDelivery(orderId, driver.id);
    }
    // Clés alignées sur statusMessages dans notifications.service.ts.
    // Avant : 'ORDER_DELIVERED'/'ORDER_IN_DELIVERY' -> undefined -> aucune
    // notif envoyée au client pendant toute la phase de livraison.
    await this.notifications.sendOrderNotification(orderId, status === 'DELIVERED' ? 'DELIVERED' : 'IN_DELIVERY');

    // Sprint C - emit le statut FIN (status driver) sur la room order_<id>
    // pour que le tracking client puisse afficher la bonne étape :
    //   HEADING_TO_PICKUP   -> "Livreur récupère commande"
    //   ARRIVED_AT_PICKUP   -> "Livreur arrivé au resto"
    //   PICKED_UP           -> "Commande prise"
    //   IN_DELIVERY         -> "Livreur en route vers vous"
    //   DELIVERED           -> "Livré !"
    // Distinction importante vs notif FCM unique : ici on a 5 etapes
    // distinctes au lieu d'un message générique "en livraison".
    this.deliveriesGateway.emitOrderStatus(orderId, status, {
      deliveryStep: true,
      ...(confirmPhoto && { confirmPhoto }),
    });
    return { success: true };
  }

  async getDashboard(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    const today = new Date(); today.setHours(0,0,0,0);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      todayDeliveries, weekDeliveries, monthDeliveries, allDeliveries, avgRating,
      todayEarningsAgg, weekEarningsAgg, monthEarningsAgg, totalEarningsAgg,
      totalTipsAgg, totalPayoutsAgg, pendingWithdrawalsAgg,
    ] = await Promise.all([
      this.prisma.delivery.count({ where: { driverId: driver.id, status: 'DELIVERED', createdAt: { gte: today } } }),
      this.prisma.delivery.count({ where: { driverId: driver.id, status: 'DELIVERED', createdAt: { gte: weekStart } } }),
      this.prisma.delivery.count({ where: { driverId: driver.id, status: 'DELIVERED', createdAt: { gte: monthStart } } }),
      this.prisma.delivery.count({ where: { driverId: driver.id, status: 'DELIVERED' } }),
      this.prisma.review.aggregate({ where: { driverId: driver.id }, _avg: { driverRating: true } }),
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'DELIVERY_FEE', status: 'COMPLETED', createdAt: { gte: today } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'DELIVERY_FEE', status: 'COMPLETED', createdAt: { gte: weekStart } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'DELIVERY_FEE', status: 'COMPLETED', createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'DELIVERY_FEE', status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      // Pourboires reçus (type TIP, status COMPLETED)
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'TIP', status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      // Virements déjà exécutés (WITHDRAWAL COMPLETED)
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'WITHDRAWAL' as any, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      // Virements en attente (WITHDRAWAL PENDING) — déduits du solde disponible
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'WITHDRAWAL' as any, status: 'PENDING' },
        _sum: { amount: true },
      }),
    ]);

    const totalCommissions = totalEarningsAgg._sum.amount ?? 0;
    const totalTips        = totalTipsAgg._sum.amount     ?? 0;
    const totalPaidOut     = totalPayoutsAgg._sum.amount  ?? 0;
    const pendingPayouts   = pendingWithdrawalsAgg._sum.amount ?? 0;
    const availableBalance = totalCommissions + totalTips - totalPaidOut - pendingPayouts;

    return { data: {
      todayDeliveries,
      weekDeliveries,
      monthDeliveries,
      allDeliveries,
      avgRating:        avgRating._avg.driverRating,
      todayEarnings:    todayEarningsAgg._sum.amount  ?? 0,
      weekEarnings:     weekEarningsAgg._sum.amount   ?? 0,
      monthEarnings:    monthEarningsAgg._sum.amount  ?? 0,
      totalEarnings:    totalCommissions,
      totalTips,
      availableBalance: Math.max(0, availableBalance),
      pendingPayouts,
    } };
  }

  async requestWithdrawal(userId: string, amount: number) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();
    if (amount <= 0) throw new BadRequestException('Le montant doit être supérieur à 0');

    // Recalcule le solde disponible en temps réel pour éviter les race conditions.
    const [earningsAgg, tipsAgg, paidOutAgg, pendingAgg] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'DELIVERY_FEE', status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'TIP', status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'WITHDRAWAL' as any, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { driverId: driver.id, type: 'WITHDRAWAL' as any, status: 'PENDING' },
        _sum: { amount: true },
      }),
    ]);
    const available = Math.max(0,
      (earningsAgg._sum.amount ?? 0) + (tipsAgg._sum.amount ?? 0)
      - (paidOutAgg._sum.amount ?? 0) - (pendingAgg._sum.amount ?? 0)
    );

    if (amount > available) {
      throw new BadRequestException(
        `Montant supérieur au solde disponible (${available.toFixed(0)} F)`
      );
    }

    const withdrawal = await this.prisma.transaction.create({
      data: {
        driverId:    driver.id,
        type:        'WITHDRAWAL' as any,
        amount,
        currency:    'XOF',
        status:      'PENDING',
        description: `Demande de virement — ${new Date().toLocaleDateString('fr-FR')}`,
      },
    });
    return { data: withdrawal };
  }

  async getActiveMissions(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();
    const deliveries = await this.prisma.delivery.findMany({
      where: {
        driverId: driver.id,
        status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] as any },
      },
      include: {
        order: {
          include: {
            professional: { select: { businessName: true, address: true, phone: true, lat: true, lng: true } },
            client: { select: { name: true, firstName: true, phone: true } },
            items: { include: { product: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: deliveries };
  }

  /** Config driver-facing (timeout mission + fournisseur navigation). */
  async getDriverConfig() {
    const [timeoutCfg, navCfg, confirmCfg] = await Promise.all([
      this.prisma.platformConfig.findUnique({ where: { key: 'mission_accept_timeout' } }),
      this.prisma.platformConfig.findUnique({ where: { key: 'navigation_provider' } }),
      this.prisma.platformConfig.findUnique({ where: { key: 'delivery_confirm_code' } }),
    ]);
    const confirmVal = confirmCfg?.value as any;
    return {
      data: {
        missionTimeoutSeconds:     (timeoutCfg?.value as any)?.seconds  ?? 30,
        navigationProvider:        (navCfg?.value   as any)?.provider   ?? 'GOOGLE_MAPS',
        confirmationCodeEnabled:   confirmVal?.enabled  ?? false,
        confirmationCodeDigits:    confirmVal?.digits   ?? 4,
      },
    };
  }

  async getEarnings(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();
    const transactions = await this.prisma.transaction.findMany({
      where: {
        driverId: driver.id,
        // Exclut COMMISSION et PAYOUT qui sont des transactions internes plateforme.
        type: { in: ['DELIVERY_FEE', 'TIP', 'WITHDRAWAL'] as any },
      },
      orderBy: { createdAt: 'desc' },
      take: 150,
    });
    return { data: transactions };
  }

  private async creditAfterDelivery(orderId: string, driverId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    // Credit driver delivery fee
    await this.prisma.transaction.create({
      data: { driverId, type: 'DELIVERY_FEE', amount: order.deliveryFee, currency: order.currency, status: 'COMPLETED', description: `Delivery for order ${orderId}` },
    });

    // Credit professional (total - commission)
    const profAmount = order.subtotal - order.commissionAmount;
    await this.prisma.transaction.create({
      data: { professionalId: order.professionalId, type: 'PAYOUT', amount: profAmount, currency: order.currency, status: 'PENDING', description: `Revenue for order ${orderId}` },
    });

    // Platform commission
    await this.prisma.transaction.create({
      data: { type: 'COMMISSION', amount: order.commissionAmount, currency: order.currency, status: 'COMPLETED', description: `Commission for order ${orderId}` },
    });
  }

  // ── Sélection de zones (zones créées par l'admin) ────────────────────────

  /** Retourne toutes les DeliveryZone actives avec un flag `selected` indiquant
   *  si le livreur a déjà sélectionné cette zone. */
  async getZones(userId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      select: { id: true, selectedZones: { select: { deliveryZoneId: true } } },
    });
    if (!driver) throw new NotFoundException('Driver profile not found');

    const allZones = await this.prisma.deliveryZone.findMany({
      where: { isActive: true },
      orderBy: [{ country: 'asc' }, { name: 'asc' }],
    });

    const selectedIds = new Set(driver.selectedZones.map((s) => s.deliveryZoneId));
    return {
      data: allZones.map((z) => ({ ...z, selected: selectedIds.has(z.id) })),
    };
  }

  /** Le livreur sélectionne une zone admin (idempotent). */
  async addZone(userId: string, dto: SelectDriverZoneDto) {
    const driver = await this.prisma.driver.findUnique({ where: { userId }, select: { id: true } });
    if (!driver) throw new NotFoundException('Driver profile not found');

    const zone = await this.prisma.deliveryZone.findUnique({ where: { id: dto.deliveryZoneId } });
    if (!zone || !zone.isActive) throw new NotFoundException('Zone not found or inactive');

    await this.prisma.driverDeliveryZone.upsert({
      where: { driverId_deliveryZoneId: { driverId: driver.id, deliveryZoneId: dto.deliveryZoneId } },
      create: { driverId: driver.id, deliveryZoneId: dto.deliveryZoneId },
      update: {},
    });
    return { data: { selected: true, deliveryZoneId: dto.deliveryZoneId } };
  }

  /** Le livreur désélectionne une zone admin. */
  async deleteZone(userId: string, deliveryZoneId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId }, select: { id: true } });
    if (!driver) throw new NotFoundException('Driver profile not found');
    await this.prisma.driverDeliveryZone.deleteMany({
      where: { driverId: driver.id, deliveryZoneId },
    });
    return { data: { selected: false, deliveryZoneId } };
  }

  // ── Documents ────────────────────────────────────────────────────────────

  async getDocuments(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId }, select: { id: true } });
    if (!driver) throw new NotFoundException('Driver profile not found');
    const docs = await this.prisma.document.findMany({
      where: { driverId: driver.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data: docs };
  }

  async uploadDocument(userId: string, file: Express.Multer.File, docType: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId }, select: { id: true } });
    if (!driver) throw new NotFoundException('Driver profile not found');
    await this.prisma.document.deleteMany({ where: { driverId: driver.id, type: docType } });
    const url = await this.uploads.uploadFile(file, 'ife-food/documents/driver');
    const doc = await this.prisma.document.create({ data: { driverId: driver.id, type: docType, url } });
    return { data: doc };
  }
}
