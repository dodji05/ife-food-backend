import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateDriverDto, UpdateDriverDto, UpdateLocationDto } from './dto/driver.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

// ─── Constantes métier multi-livraison ────────────────────────────────────────
const MAX_ROUTE_DEVIATION_KM   = 3.0;  // Déviation max du trajet pour accepter une mission compatible
const MAX_ESTIMATED_EXTRA_MIN  = 15;   // Délai supplémentaire max acceptable (minutes)
const HAVERSINE_EARTH_RADIUS_KM = 6371;

@Injectable()
export class DriversService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ─── Profil ─────────────────────────────────────────────────────────────────

  async register(userId: string, dto: CreateDriverDto) {
    return this.prisma.driver.create({
      data: { ...dto, userId, vehicleType: dto.vehicleType as any, status: 'PENDING' },
    });
  }

  async getMyProfile(userId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      include: { documents: true },
    });
    if (!driver) throw new NotFoundException('Driver profile not found');
    return { data: driver };
  }

  async updateProfile(userId: string, dto: UpdateDriverDto) {
    return this.prisma.driver.update({ where: { userId }, data: dto });
  }

  // ─── Disponibilité ──────────────────────────────────────────────────────────

  async toggleAvailability(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    // Ne pas passer hors ligne si des livraisons sont encore actives
    if (driver.isAvailable) {
      const activeCount = await this._countActiveMissions(driver.id);
      if (activeCount > 0) {
        throw new BadRequestException(
          `Impossible de passer hors ligne : ${activeCount} livraison(s) en cours. ` +
          `Terminez-les avant de vous déconnecter.`
        );
      }
    }

    const newStatus = driver.isAvailable ? 'OFFLINE' : 'ONLINE';
    const updated = await this.prisma.driver.update({
      where: { userId },
      data: { isAvailable: !driver.isAvailable, status: newStatus as any },
    });
    return { data: updated };
  }

  // ─── GPS ────────────────────────────────────────────────────────────────────

  async updateLocation(userId: string, dto: UpdateLocationDto) {
    const driver = await this.prisma.driver.update({
      where: { userId },
      data: { currentLat: dto.lat, currentLng: dto.lng },
    });

    // Met à jour la position dans TOUTES les livraisons actives du livreur
    await this.prisma.delivery.updateMany({
      where: {
        driverId: driver.id,
        status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] },
      },
      data: { driverLat: dto.lat, driverLng: dto.lng },
    });

    return { data: driver };
  }

  // ─── Attribution des missions ────────────────────────────────────────────────

  /**
   * Récupère les livreurs disponibles triés par distance.
   * NOUVEAU : filtre aussi les livreurs qui ont atteint leur capacité max.
   * NOUVEAU : pour un livreur ayant déjà des missions actives, calcule la
   *           compatibilité de trajet avant de l'inclure dans les résultats.
   */
  async getAvailableDrivers(
    pickupLat: number, pickupLng: number,
    deliveryLat: number, deliveryLng: number,
    radiusKm: number = 5,
  ) {
    const drivers = await this.prisma.driver.findMany({
      where: { isAvailable: true, status: 'ONLINE' },
      include: {
        user: { select: { name: true, firstName: true, avatarUrl: true, fcmToken: true } },
        deliveries: {
          where: {
            status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] },
          },
          include: { order: { select: { deliveryLat: true, deliveryLng: true } } },
        },
      },
    });

    const eligible = drivers
      .filter((d) => {
        if (!d.currentLat || !d.currentLng) return false;

        // Filtre 1 : distance au point de pickup
        const distToPickup = this._haversine(pickupLat, pickupLng, d.currentLat, d.currentLng);
        if (distToPickup > radiusKm) return false;

        // Filtre 2 : capacité non atteinte
        const activeMissions = d.deliveries.length;
        if (activeMissions >= d.maxConcurrentDeliveries) return false;

        // Filtre 3 : si le livreur a déjà des missions, vérifier la compatibilité de trajet
        if (activeMissions > 0) {
          return this._isRouteCompatible(d, pickupLat, pickupLng, deliveryLat, deliveryLng);
        }

        return true;
      })
      .sort((a, b) => {
        const distA = this._haversine(pickupLat, pickupLng, a.currentLat!, a.currentLng!);
        const distB = this._haversine(pickupLat, pickupLng, b.currentLat!, b.currentLng!);
        return distA - distB;
      });

    return eligible;
  }

  /**
   * Le livreur accepte une mission.
   * NOUVEAU : vérifie la capacité avant d'accepter.
   * NOUVEAU : stocke l'ordre dans la relation Delivery (déjà 1:1 par orderId).
   */
  async acceptMission(userId: string, orderId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    // ── Garde capacité ──────────────────────────────────────────────────────
    const activeMissions = await this._countActiveMissions(driver.id);
    if (activeMissions >= driver.maxConcurrentDeliveries) {
      throw new BadRequestException(
        `Capacité maximale atteinte (${driver.maxConcurrentDeliveries} mission(s) simultanée(s)). ` +
        `Terminez une livraison avant d'en accepter une nouvelle.`
      );
    }

    // ── Vérification compatibilité de trajet si missions en cours ───────────
    if (activeMissions > 0) {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { professional: { select: { lat: true, lng: true } } },
      });
      if (!order) throw new NotFoundException('Order not found');

      const driverFull = await this.prisma.driver.findUnique({
        where: { id: driver.id },
        include: {
          deliveries: {
            where: { status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] } },
            include: { order: { select: { deliveryLat: true, deliveryLng: true } } },
          },
        },
      });

      const compatible = this._isRouteCompatible(
        driverFull!,
        order.professional!.lat, order.professional!.lng,
        order.deliveryLat, order.deliveryLng,
      );
      if (!compatible) {
        throw new BadRequestException(
          'Cette livraison n\'est pas compatible avec votre trajet actuel. ' +
          'Le point de pickup ou de livraison est trop éloigné de votre itinéraire.'
        );
      }
    }

    // ── Assignation ─────────────────────────────────────────────────────────
    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: orderId },
        data: { driverId: driver.id, status: 'DRIVER_ASSIGNED' },
      }),
      this.prisma.delivery.create({
        data: { orderId, driverId: driver.id, status: 'ASSIGNED' },
      }),
    ]);

    await this.notifications.sendOrderNotification(orderId, 'DRIVER_ASSIGNED');
    return { success: true };
  }

  /**
   * Mise à jour du statut d'une livraison spécifique.
   * NOUVEAU : ne touche que la livraison ciblée, les autres restent intactes.
   */
  async updateDeliveryStatus(
    userId: string, orderId: string,
    status: string, confirmPhoto?: string,
  ) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    const delivery = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (!delivery || delivery.driverId !== driver.id) throw new ForbiddenException();

    // Mise à jour de la livraison spécifique uniquement
    await this.prisma.delivery.update({
      where: { orderId },
      data: {
        status: status as any,
        ...(confirmPhoto && { confirmPhoto }),
        ...(status === 'DELIVERED'  && { deliveredTime: new Date() }),
        ...(status === 'PICKED_UP'  && { pickupTime:    new Date() }),
      },
    });

    if (status === 'DELIVERED') {
      await this.prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
      await this._creditAfterDelivery(orderId, driver.id);
    }

    // Notif ciblée sur cette commande uniquement
    await this.notifications.sendOrderNotification(
      orderId,
      status === 'DELIVERED' ? 'DELIVERED' : 'IN_DELIVERY',
    );

    return { success: true };
  }

  // ─── Dashboard & gains ──────────────────────────────────────────────────────

  async getDashboard(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [todayDeliveries, allDeliveries, avgRating, activeMissions] = await Promise.all([
      this.prisma.delivery.count({ where: { driverId: driver.id, status: 'DELIVERED', createdAt: { gte: today } } }),
      this.prisma.delivery.count({ where: { driverId: driver.id, status: 'DELIVERED' } }),
      this.prisma.review.aggregate({ where: { driverId: driver.id }, _avg: { driverRating: true } }),
      this._countActiveMissions(driver.id),
    ]);

    const earnings = await this.prisma.transaction.aggregate({
      where: { driverId: driver.id, type: 'DELIVERY_FEE', status: 'COMPLETED' },
      _sum: { amount: true },
    });

    return {
      data: {
        todayDeliveries,
        allDeliveries,
        avgRating: avgRating._avg.driverRating,
        totalEarnings: earnings._sum.amount ?? 0,
        activeMissions,                               // NOUVEAU
        maxConcurrentDeliveries: driver.maxConcurrentDeliveries,  // NOUVEAU
      },
    };
  }

  /**
   * NOUVEAU — Liste toutes les missions actives du livreur connecté.
   * Utilisé par l'app Flutter pour afficher le sélecteur multi-missions.
   */
  async getActiveMissions(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    const deliveries = await this.prisma.delivery.findMany({
      where: {
        driverId: driver.id,
        status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] },
      },
      include: {
        order: {
          include: {
            professional: { select: { businessName: true, address: true, lat: true, lng: true } },
            items:        { include: { product: { select: { name: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' }, // Ordre chronologique d'acceptation
    });

    return { data: deliveries };
  }

  // ─── Helpers privés ─────────────────────────────────────────────────────────

  private async _countActiveMissions(driverId: string): Promise<number> {
    return this.prisma.delivery.count({
      where: {
        driverId,
        status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] },
      },
    });
  }

  /**
   * Vérifie si une nouvelle mission est compatible avec l'itinéraire actuel du livreur.
   *
   * Logique :
   *   Pour chaque livraison active, on calcule la déviation que représenterait
   *   le nouveau pickup et le nouveau drop-off par rapport au trajet actuel.
   *   Si la déviation max est inférieure à MAX_ROUTE_DEVIATION_KM → compatible.
   *
   * On utilise la heuristique du "détour minimal" :
   *   détour = dist(currentPos → newPickup) + dist(newPickup → newDelivery)
   *           - dist(currentPos → nearestActiveDestination)
   */
  private _isRouteCompatible(
    driver: any,          // Driver avec deliveries chargées
    newPickupLat: number, newPickupLng: number,
    newDeliveryLat: number, newDeliveryLng: number,
  ): boolean {
    if (!driver.currentLat || !driver.currentLng) return false;

    // Collecte des destinations actives (points de livraison en cours)
    const activeDestinations: Array<{ lat: number; lng: number }> = driver.deliveries
      .filter((d: any) => d.order?.deliveryLat && d.order?.deliveryLng)
      .map((d: any) => ({ lat: d.order.deliveryLat, lng: d.order.deliveryLng }));

    if (activeDestinations.length === 0) return true;

    // Distance driver → nouveau pickup
    const distToNewPickup = this._haversine(
      driver.currentLat, driver.currentLng,
      newPickupLat, newPickupLng,
    );

    // Distance nouveau pickup → nouvelle livraison
    const newSegmentDist = this._haversine(newPickupLat, newPickupLng, newDeliveryLat, newDeliveryLng);

    // Distance driver → destination la plus proche parmi les missions actives
    const minDistToExisting = Math.min(
      ...activeDestinations.map((d) =>
        this._haversine(driver.currentLat, driver.currentLng, d.lat, d.lng)
      )
    );

    // Détour estimé = aller au nouveau pickup + livrer, vs aller directement à la dest. la plus proche
    const detour = distToNewPickup + newSegmentDist - minDistToExisting;

    // Vérifications :
    //  1. Le détour total ne dépasse pas MAX_ROUTE_DEVIATION_KM
    //  2. Le nouveau pickup n'est pas trop loin (évite les missions à l'autre bout de la ville)
    const extraMinutes = (detour / 25) * 60; // estimation à 25 km/h vitesse moyenne urbaine

    return detour <= MAX_ROUTE_DEVIATION_KM && extraMinutes <= MAX_ESTIMATED_EXTRA_MIN;
  }

  private _haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return HAVERSINE_EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private async _creditAfterDelivery(orderId: string, driverId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    await this.prisma.$transaction([
      // Crédit livreur
      this.prisma.transaction.create({
        data: {
          driverId, type: 'DELIVERY_FEE',
          amount: order.deliveryFee, currency: order.currency,
          status: 'COMPLETED', description: `Delivery for order ${orderId}`,
        },
      }),
      // Crédit professionnel
      this.prisma.transaction.create({
        data: {
          professionalId: order.professionalId, type: 'PAYOUT',
          amount: order.subtotal - order.commissionAmount, currency: order.currency,
          status: 'PENDING', description: `Revenue for order ${orderId}`,
        },
      }),
      // Commission plateforme
      this.prisma.transaction.create({
        data: {
          type: 'COMMISSION',
          amount: order.commissionAmount, currency: order.currency,
          status: 'COMPLETED', description: `Commission for order ${orderId}`,
        },
      }),
    ]);
  }

  // ─── Gains ──────────────────────────────────────────────────────────────────

  async getEarnings(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException('Driver profile not found');

    const transactions = await this.prisma.transaction.findMany({
      where: { driverId: driver.id, type: 'DELIVERY_FEE', status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const total = transactions.reduce((sum, t) => sum + Number(t.amount), 0);
    return { data: { transactions, total } };
  }

  // ─── Admin : mise à jour de la capacité d'un livreur ────────────────────────

  async updateCapacity(driverId: string, max: number) {
    if (max < 1 || max > 5) throw new BadRequestException('La capacité doit être entre 1 et 5');
    return this.prisma.driver.update({
      where: { id: driverId },
      data: { maxConcurrentDeliveries: max },
    });
  }
}
