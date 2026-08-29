import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GeoService } from '../geo/geo.service';
import { DeliveriesGateway } from '../deliveries/deliveries.gateway';
import { CreateOrderDto, UpdateOrderStatusDto, ACTIVE_ORDER_STATUSES } from './dto/order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  // ── Dispatch state ────────────────────────────────────────────────────────
  // Mémorise l'état de dispatch en cours par orderId :
  //   - timeoutHandle : le setTimeout à annuler si le driver accepte
  //   - triedUserIds  : drivers déjà contactés (exclus des retries)
  //   - retryCount    : nombre de tentatives effectuées
  //
  // JS single-threaded → pas de race condition sur la Map.
  // Pour un déploiement multi-instance, remplacer par Redis + BullMQ.
  private readonly pendingDispatches = new Map<string, {
    timeoutHandle: ReturnType<typeof setTimeout>;
    triedUserIds:  Set<string>;
    retryCount:    number;
    expiresAt:     number; // timestamp ms de fin de la fenêtre d'acceptation
  }>();
  private readonly MAX_DISPATCH_RETRIES = 3;

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private geo: GeoService,
    private config: ConfigService,
    private deliveriesGateway: DeliveriesGateway,
  ) {}

  private async dispatchNewMission(
    orderId: string,
    triedUserIds = new Set<string>(),
    retryCount = 0,
  ) {
    if (retryCount > this.MAX_DISPATCH_RETRIES) {
      this.logger.warn(`[dispatch] Max retries (${this.MAX_DISPATCH_RETRIES}) atteint pour order ${orderId}`);
      this.pendingDispatches.delete(orderId);
      return;
    }

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          professional: { select: { businessName: true, address: true, phone: true, lat: true, lng: true, city: true } },
          items: { include: { product: true } },
        },
      });
      if (!order || order.driverId) {
        this.pendingDispatches.delete(orderId);
        return;
      }

      const toRad = (d: number) => (d * Math.PI) / 180;
      const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
        return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      };

      // Priorité à la distance routière stockée sur l'order (Google Maps),
      // fallback sur Haversine si le champ est absent (anciennes commandes).
      const distanceKm = (order as any).distanceKm != null
        ? Number((order as any).distanceKm)
        : haversine(
            order.professional.lat, order.professional.lng,
            order.deliveryLat, order.deliveryLng,
          );
      const estimatedMinutes = Math.max(10, Math.round(distanceKm * 3 + 5));
      const deliveryZone = (order as any).deliveryCity ?? order.professional.city ?? '';

      const [capConfig, timeoutConfig, radiusConfig] = await Promise.all([
        this.prisma.platformConfig.findUnique({ where: { key: 'vehicle_capacity' } }),
        this.prisma.platformConfig.findUnique({ where: { key: 'mission_accept_timeout' } }),
        this.prisma.platformConfig.findUnique({ where: { key: 'dispatch_radius' } }),
      ]);
      const vehicleCapacities: Record<string, number> = {
        BICYCLE: 2, MOTORCYCLE: 5, CAR: 10, ON_FOOT: 1,
        ...(capConfig?.value as any ?? {}),
      };
      // Rayon max (km) autour du pro pour qu'un livreur soit éligible au
      // dispatch — configurable admin, 20km si non défini.
      const dispatchRadiusKm: number = (radiusConfig?.value as any)?.km ?? 20;
      const timeoutSeconds: number = (timeoutConfig?.value as any)?.seconds ?? 30;

      const basePayload = {
        orderId:             order.id,
        professionalName:    order.professional.businessName,
        professionalAddress: order.professional.address,
        professionalPhone:   order.professional.phone ?? '',
        professionalLat:     order.professional.lat,
        professionalLng:     order.professional.lng,
        deliveryAddress:     order.deliveryAddress,
        deliveryZone,
        deliveryLat:         order.deliveryLat,
        deliveryLng:         order.deliveryLng,
        deliveryFee:         order.deliveryFee,
        currency:            order.currency,
        distanceKm,
        estimatedMinutes,
        items:               order.items,
      };

      // Drivers éligibles non encore contactés pour cette commande.
      // status 'ONLINE' = validé + en ligne (toggleAvailability écrit ONLINE/OFFLINE,
      // pas VALIDATED — le filtre VALIDATED était erroné et bloquait tout dispatch).
      const eligibleDrivers = await this.prisma.driver.findMany({
        where: {
          status:      'ONLINE' as any,
          isAvailable: true,
          ...(triedUserIds.size > 0 && { userId: { notIn: Array.from(triedUserIds) } }),
        },
        select: {
          id: true, userId: true, vehicleType: true,
          zoneCity: true, currentLat: true, currentLng: true,
          selectedZones: { select: { deliveryZone: { select: { fromCity: true } } } },
          _count: { select: { deliveries: { where: { status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] as any } } } } },
        },
      });

      const proCity = order.professional.city?.toLowerCase() ?? '';
      const available = eligibleDrivers.filter((d) => {
        if (d._count.deliveries >= (vehicleCapacities[d.vehicleType as string] ?? 3)) return false;

        // Vérification de zone : zones sélectionnées par le livreur (DriverDeliveryZone)
        // en priorité, sinon fallback sur l'ancien champ zoneCity.
        const selectedZones = (d as any).selectedZones as { deliveryZone: { fromCity: string | null } }[];
        if (selectedZones?.length > 0) {
          const zoneMatch = selectedZones.some(
            (s) => s.deliveryZone.fromCity?.toLowerCase() === proCity
          );
          if (proCity && !zoneMatch) return false;
        } else if ((d as any).zoneCity && proCity && (d as any).zoneCity.toLowerCase() !== proCity) {
          return false;
        }

        if (d.currentLat != null && d.currentLng != null &&
            haversine(d.currentLat, d.currentLng, order.professional.lat, order.professional.lng) > dispatchRadiusKm) return false;
        return true;
      });

      if (available.length === 0) {
        this.logger.warn(`[dispatch] retry=${retryCount} aucun driver disponible pour order ${orderId}`);
        this.pendingDispatches.delete(orderId);
        return;
      }

      // Le plus proche du pro est notifié en premier. Le dispatch reste un
      // broadcast à tous les éligibles (pas un contact séquentiel un par
      // un) — cet ordre lui donne juste une petite longueur d'avance
      // réelle sur l'envoi des push. La résolution en cas d'acceptations
      // quasi simultanées reste gérée par la transaction DB (premier
      // arrivé, premier servi), aucune vraie égalité n'étant possible au
      // niveau base de données.
      available.sort((a, b) => {
        const da = (a.currentLat != null && a.currentLng != null)
          ? haversine(a.currentLat, a.currentLng, order.professional.lat, order.professional.lng) : Infinity;
        const db = (b.currentLat != null && b.currentLng != null)
          ? haversine(b.currentLat, b.currentLng, order.professional.lat, order.professional.lng) : Infinity;
        return da - db;
      });

      this.logger.log(`[dispatch] retry=${retryCount} order ${orderId} -> ${available.length} driver(s)`);

      const newTriedUserIds = new Set(triedUserIds);
      for (const d of available) {
        const distanceToPickupKm = (d.currentLat != null && d.currentLng != null)
          ? haversine(d.currentLat, d.currentLng, order.professional.lat, order.professional.lng)
          : null;

        this.deliveriesGateway.emitNewMission({ ...basePayload, distanceToPickupKm, driverUserId: d.userId });
        this.notifications.sendDriverMissionPush(d.userId, {
          orderId: order.id, professionalName: order.professional.businessName,
          professionalAddress: order.professional.address, deliveryZone,
          distanceToPickupKm, distanceKm, deliveryFee: order.deliveryFee, currency: order.currency,
        }).catch(() => {});
        newTriedUserIds.add(d.userId);
      }

      // Annule l'éventuel timeout précédent.
      const existing = this.pendingDispatches.get(orderId);
      if (existing) clearTimeout(existing.timeoutHandle);

      // Timeout configuré via PlatformConfig key='mission_accept_timeout' (défaut 30s).
      // Quand il expire : si la commande est toujours non assignée, on réessaie
      // avec les drivers pas encore contactés (max MAX_DISPATCH_RETRIES fois).
      const timeoutHandle = setTimeout(async () => {
        const latest = await this.prisma.order.findUnique({
          where: { id: orderId }, select: { driverId: true },
        });
        if (latest?.driverId) { this.pendingDispatches.delete(orderId); return; }
        this.logger.log(`[dispatch] Expiration order ${orderId} — retry ${retryCount + 1}`);
        this.pendingDispatches.delete(orderId);
        this.dispatchNewMission(orderId, newTriedUserIds, retryCount + 1);
      }, timeoutSeconds * 1000);

      this.pendingDispatches.set(orderId, {
        timeoutHandle, triedUserIds: newTriedUserIds, retryCount,
        expiresAt: Date.now() + timeoutSeconds * 1000,
      });
    } catch (e) {
      this.logger.error(`[dispatch] Erreur: ${e}`);
    }
  }

  /**
   * Missions actuellement disponibles pour un livreur (fenêtre d'acceptation
   * encore ouverte). Mêmes filtres d'éligibilité que dispatchNewMission.
   * Renvoie aussi `remainingSeconds` pour le compte à rebours côté mobile.
   */
  async getAvailableMissions(driverUserId: string) {
    const now = Date.now();
    // OrderIds encore dans leur fenêtre d'acceptation.
    const openOrderIds = [...this.pendingDispatches.entries()]
      .filter(([, s]) => s.expiresAt > now)
      .map(([orderId]) => orderId);
    if (openOrderIds.length === 0) return { data: [] };

    const driver = await this.prisma.driver.findUnique({ where: { userId: driverUserId } });
    if (!driver || driver.status !== 'ONLINE' || !driver.isAvailable) return { data: [] };

    const orders = await this.prisma.order.findMany({
      where: { id: { in: openOrderIds }, driverId: null, status: 'READY_FOR_PICKUP' as any },
      include: {
        professional: { select: { businessName: true, address: true, phone: true, lat: true, lng: true, city: true } },
        items: { include: { product: true } },
      },
    });

    const toRad = (d: number) => (d * Math.PI) / 180;
    const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
      const dLat = toRad(lat2 - lat1); const dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    const result = orders
      .filter((order) => {
        // Même filtre distance que le dispatch (≤ 20 km du pro).
        if (driver.currentLat != null && driver.currentLng != null &&
            haversine(driver.currentLat, driver.currentLng, order.professional.lat, order.professional.lng) > 20) {
          return false;
        }
        // Filtre zone : la ville du pro doit correspondre à la zone du livreur.
        const proCity = order.professional.city?.toLowerCase() ?? '';
        if ((driver as any).zoneCity && proCity && (driver as any).zoneCity.toLowerCase() !== proCity) {
          return false;
        }
        return true;
      })
      .map((order) => {
        const distanceKm = haversine(
          order.professional.lat, order.professional.lng,
          order.deliveryLat, order.deliveryLng,
        );
        const distanceToPickupKm = (driver.currentLat != null && driver.currentLng != null)
          ? haversine(driver.currentLat, driver.currentLng, order.professional.lat, order.professional.lng)
          : null;
        const state = this.pendingDispatches.get(order.id);
        const remainingSeconds = state ? Math.max(0, Math.round((state.expiresAt - now) / 1000)) : 0;
        return {
          orderId:             order.id,
          professionalName:    order.professional.businessName,
          professionalAddress: order.professional.address,
          professionalPhone:   order.professional.phone ?? '',
          professionalLat:     order.professional.lat,
          professionalLng:     order.professional.lng,
          deliveryAddress:     order.deliveryAddress,
          deliveryLat:         order.deliveryLat,
          deliveryLng:         order.deliveryLng,
          deliveryFee:         order.deliveryFee,
          currency:            order.currency,
          distanceKm,
          distanceToPickupKm,
          remainingSeconds,
          items:               order.items,
        };
      });

    return { data: result };
  }

  /** Refus explicite d'un driver → réattribution immédiate aux drivers restants. */
  async handleDriverDecline(orderId: string, driverUserId: string) {
    const state = this.pendingDispatches.get(orderId);
    if (state) {
      clearTimeout(state.timeoutHandle);
      state.triedUserIds.add(driverUserId);
      this.pendingDispatches.delete(orderId);
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId }, select: { driverId: true },
    });
    if (order && !order.driverId) {
      const tried = state ? state.triedUserIds : new Set([driverUserId]);
      this.dispatchNewMission(orderId, tried, state?.retryCount ?? 0);
    }
  }

  /** Annule le timeout de dispatch après acceptation d'une mission. */
  clearPendingDispatch(orderId: string) {
    const state = this.pendingDispatches.get(orderId);
    if (state) { clearTimeout(state.timeoutHandle); this.pendingDispatches.delete(orderId); }
  }

  async createOrder(clientId: string, dto: CreateOrderDto) {
    // Charger tous les produits en une seule requête (évite le pattern N+1)
    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const baseItems = dto.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product || !product.isAvailable) throw new BadRequestException(`Product ${item.productId} unavailable`);
      return { ...item, unitPrice: product.price, totalPrice: product.price * item.quantity, product };
    });

    // Get commission config (supports new format { professional: {type,value} } and legacy { type, value })
    const commissionConfig = await this.prisma.platformConfig.findUnique({ where: { key: 'commission' } });
    const cfg = commissionConfig?.value as any;
    const proCfg = cfg?.professional ?? cfg;

    const baseSubtotal   = baseItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const totalItemCount = baseItems.reduce((sum, i) => sum + i.quantity, 0);

    let commissionAmount = 0;
    let orderItems = baseItems;

    // ── Paliers RPO (prioritaire sur type/value) ──────────────────────────────
    // Sélectionne le palier selon le nombre total de plats commandés :
    //   palier 0 : ≤ 2 plats | palier 1 : 3–6 | palier 2 : 7–10 | palier 3 : > 10
    const selectTier = (tiers: any[], count: number) => {
      if (!Array.isArray(tiers) || tiers.length < 4) return null;
      if (count <= 2)  return tiers[0];
      if (count <= 6)  return tiers[1];
      if (count <= 10) return tiers[2];
      return tiers[3];
    };

    const proTier   = proCfg?.tiers ? selectTier(proCfg.tiers, totalItemCount) : null;
    const tierRate  = proTier ? Number(proTier.rate ?? 0) : 0;
    const tierFixed = proTier ? Number(proTier.fixedAmount ?? 0) : 0;

    if (tierRate > 0 || tierFixed > 0) {
      // Taux (%) sur le sous-total
      if (tierRate > 0) commissionAmount += baseSubtotal * (tierRate / 100);
      // Montant fixe × nombre de plats commandés (tierFixed = tarif par plat)
      if (tierFixed > 0) commissionAmount += tierFixed * totalItemCount;

    // ── Fallback : mode global type/value (legacy + rétrocompatibilité) ───────
    } else if (proCfg?.type === 'PERCENTAGE') {
      commissionAmount = baseSubtotal * (Number(proCfg.value) / 100);
    } else if (proCfg?.type === 'FIXED_PER_DISH' || proCfg?.type === 'FIXED_AMOUNT') {
      const fixedPerDish = Number(proCfg.value ?? 0);
      commissionAmount = baseItems.reduce((sum, i) => sum + fixedPerDish * i.quantity, 0);
      // Inflate unitPrice so OrderItem reflects what the client actually paid
      orderItems = baseItems.map((i) => ({
        ...i,
        unitPrice: i.unitPrice + fixedPerDish,
        totalPrice: i.totalPrice + fixedPerDish * i.quantity,
      }));
    }

    const subtotal = orderItems.reduce((sum, i) => sum + i.totalPrice, 0);

    // Calculate delivery fee
    const professional = await this.prisma.professional.findUnique({ where: { id: dto.professionalId } });
    if (!professional) throw new NotFoundException('Professionnel introuvable');
    if (professional.lat == null || professional.lng == null) {
      this.logger.warn(`Order creation: professional ${professional.id} has no coordinates, defaulting to Cotonou`);
    }
    // Calcul parallèle : frais de livraison + distance routière réelle (Google Maps)
    // getRoutingDistance utilise l'API Distance Matrix et bascule sur Haversine si
    // GOOGLE_MAPS_API_KEY est absent ou si l'API est indisponible.
    const proLat = professional.lat != null ? Number(professional.lat) : 6.36;
    const proLng = professional.lng != null ? Number(professional.lng) : 2.42;

    const [deliveryFee, distanceKm] = await Promise.all([
      this.geo.calculateDeliveryFee(
        professional.lat, professional.lng,
        dto.deliveryLat, dto.deliveryLng,
        professional.city, dto.deliveryCity,
      ),
      this.geo.getRoutingDistance(
        proLat, proLng,
        dto.deliveryLat, dto.deliveryLng,
      ),
    ]);

    // Handle promo code
    let promoDiscount = 0;
    if (dto.promoCode) {
      promoDiscount = await this.applyPromoCode(dto.promoCode, clientId, subtotal);
    }

    const totalAmount = subtotal + deliveryFee - promoDiscount;

    const order = await this.prisma.order.create({
      data: {
        clientId,
        professionalId: dto.professionalId,
        subtotal,
        deliveryFee,
        commissionAmount,
        promoCode: dto.promoCode,
        promoDiscount,
        totalAmount,
        currency: dto.currency,
        deliveryAddress: dto.deliveryAddress,
        deliveryLat: dto.deliveryLat,
        deliveryLng: dto.deliveryLng,
        deliveryCity: dto.deliveryCity,
        deliveryCountry: dto.deliveryCountry,
        paymentMethod: dto.paymentMethod as any,
        specialInstructions: dto.specialInstructions,
        scheduledDeliveryAt: dto.scheduledDeliveryAt ? new Date(dto.scheduledDeliveryAt) : null,
        // Le code de confirmation de livraison n'est généré qu'à
        // l'assignation d'un livreur (cf. generateDeliveryCode) — inutile
        // avant, et ça évite qu'il traîne en base sans destinataire.
        distanceKm,
        items: {
          create: orderItems.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            totalPrice: i.totalPrice,
            options: i.options,
          })),
        },
      },
      include: { items: { include: { product: true } }, client: true, professional: true },
    });

    // ── Mode TEST : auto-confirme le paiement immédiatement ────────────────
    // Activé via env var PAYMENT_AUTO_CONFIRM=true (à mettre dans .env du
    // VPS pour les tests). En PROD : laisser absent ou false -> le webhook
    // gateway réel (Stripe/KKIAPAY/PayPal/FedaPay) confirmera le paiement.
    //
    // Toute la logique paiement reste intacte (gateways services + webhook
    // controller). Ce flag court-circuite juste l'attente du webhook pour
    // permettre de tester le flow end-to-end sans setup gateway complet.
    //
    // Effets de bord (gérés par confirmPayment, déjà câblé) :
    //   - Payment row passe à SUCCESS
    //   - Order status passe à PAID
    //   - Notification push 'Nouvelle commande !' envoyée au pro (FCM)
    if (this.config.get('PAYMENT_AUTO_CONFIRM') === 'true') {
      this.logger.warn(`[TEST MODE] Auto-confirming payment for order ${order.id}`);
      // Crée d'abord la row Payment (sinon confirmPayment échoue sur l'update).
      // En PROD c'est PaymentsService.initiatePayment qui crée cette row à
      // l'appel POST /payments/:orderId/initiate/:gw.
      await this.prisma.payment.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          amount: order.totalAmount,
          currency: order.currency,
          gateway: order.paymentMethod as any,
          status: 'PENDING' as any,
        },
        update: {},
      });
      // Réutilise la logique standard de confirmation (transaction + notif).
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { orderId: order.id },
          data: { status: 'SUCCESS' as any, gatewayRef: `TEST_${order.id}` },
        }),
        this.prisma.order.update({
          where: { id: order.id },
          data: { paymentStatus: 'SUCCESS' as any, status: 'PAID' as any },
        }),
      ]);
      // Notif PAID au pro (best-effort, ne bloque pas la création d'order).
      this.notifications.sendOrderNotification(order.id, 'PAID').catch(() => {});
      // Emit PAID sur la room order_<id> (tracking client).
      this.deliveriesGateway.emitOrderStatus(order.id, 'PAID');
      // Notif temps réel socket → pro (room professional_<userId>).
      // Le pro reçoit `new_order` sans avoir à tracker l'orderId.
      this.deliveriesGateway.emitNewOrder((order.professional as any).userId, {
        orderId:         order.id,
        totalAmount:     (order as any).totalAmount ?? 0,
        itemCount:       order.items?.length ?? 0,
        clientName:      (order.client as any)?.name ?? (order.client as any)?.firstName ?? undefined,
        deliveryAddress: (order as any).deliveryAddress ?? '',
        createdAt:       Date.now(),
      });

      // Sprint B - le dispatch driver est maintenant déclenché à
      // READY_FOR_PICKUP (cf updateOrderStatus), plus à PAID. Ça respecte
      // le workflow métier : le pro doit confirmer ACCEPTED puis marquer
      // READY_FOR_PICKUP avant qu'un livreur soit cherché.
      //
      // Pour un mode test ULTRA-rapide (debug end-to-end), on peut
      // bypasser cette étape via env var PRO_AUTO_ACCEPT=true.
      // En MODE TEST + PRO_AUTO_ACCEPT, on simule le flux complet du pro
      // (ACCEPTED -> IN_PREPARATION -> READY_FOR_PICKUP) puis on dispatch.
      // On émet aussi les events intermédiaires pour que le tracking
      // client voit toutes les étapes même en mode test.
      if (this.config.get('PRO_AUTO_ACCEPT') === 'true') {
        this.logger.warn(`[TEST MODE] PRO_AUTO_ACCEPT actif: simule cycle pro complet pour order ${order.id}`);
        // Petites pauses entre les transitions pour que le client ait le
        // temps de voir chaque étape dans le tracking_screen (sinon les
        // 3 events arrivent en <50ms et l'UI ne show que la dernière).
        await this.prisma.order.update({
          where: { id: order.id }, data: { status: 'ACCEPTED' as any },
        });
        this.deliveriesGateway.emitOrderStatus(order.id, 'ACCEPTED');
        await new Promise((r) => setTimeout(r, 800));

        await this.prisma.order.update({
          where: { id: order.id }, data: { status: 'IN_PREPARATION' as any },
        });
        this.deliveriesGateway.emitOrderStatus(order.id, 'IN_PREPARATION');
        await new Promise((r) => setTimeout(r, 800));

        await this.prisma.order.update({
          where: { id: order.id }, data: { status: 'READY_FOR_PICKUP' as any },
        });
        this.deliveriesGateway.emitOrderStatus(order.id, 'READY_FOR_PICKUP');
        this.dispatchNewMission(order.id);
      }
      // Re-fetch pour retourner l'order avec le nouveau status
      return this.prisma.order.findUnique({
        where: { id: order.id },
        include: { items: { include: { product: true } }, client: true, professional: true },
      });
    }

    return order;
  }

  async getClientOrders(clientId: string, pagination: PaginationDto) {
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { clientId },
        include: {
          professional: { select: { businessName: true, logoUrl: true } },
          items: { include: { product: true } },
          review: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.order.count({ where: { clientId } }),
    ]);
    return { data: orders, meta: { total, page: pagination.page, limit: pagination.limit } };
  }

  async getProfessionalOrders(professionalId: string, pagination: PaginationDto, status?: string) {
    const where: any = { professionalId };
    if (status === 'active') {
      where.status = { in: [...ACTIVE_ORDER_STATUSES] };
    } else if (status) {
      where.status = status;
    }
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          client: { select: { name: true, firstName: true, phone: true, avatarUrl: true } },
          driver: {
            include: {
              user: { select: { name: true, firstName: true, phone: true, avatarUrl: true } },
            },
          },
          items: { include: { product: true } },
          payment: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    // Le code de confirmation de livraison n'est jamais exposé au pro
    // (seul le client le connaît, et le communique de vive voix au livreur).
    for (const o of orders as any[]) {
      delete o.deliveryCode;
      delete o.deliveryCodeStatus;
      delete o.deliveryCodeAttempts;
      delete o.deliveryCodeUsedAt;
    }
    return { data: orders, meta: { total, page: pagination.page, limit: pagination.limit } };
  }

  async getOrderById(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: true } },
        client: { select: { name: true, firstName: true, phone: true, avatarUrl: true } },
        // userId inclus pour la vérification d'accès (professionalId ≠ userId).
        professional: { select: { userId: true, businessName: true, address: true, phone: true, lat: true, lng: true } },
        driver: { select: { licensePlate: true, vehicleType: true, user: { select: { id: true, name: true, firstName: true, phone: true, avatarUrl: true } } } },
        delivery: true,
        payment: true,
        review: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    // order.clientId référence User directement.
    // order.professionalId référence Professional (pas User) → on compare via professional.userId.
    // order.driverId référence Driver (pas User) → on compare via driver.user.id.
    const proUserId    = (order as any).professional?.userId as string | undefined;
    const driverUserId = (order as any).driver?.user?.id    as string | undefined;
    if (order.clientId !== userId && proUserId !== userId && driverUserId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    // Le code de confirmation de livraison ne doit JAMAIS être visible par
    // le livreur ni le professionnel — uniquement par le client concerné.
    // findUnique() ci-dessus ne fait pas de select explicite (tous les
    // champs scalaires de Order sont inclus par défaut), d'où ce filtrage.
    if (order.clientId !== userId) {
      delete (order as any).deliveryCode;
      delete (order as any).deliveryCodeStatus;
      delete (order as any).deliveryCodeAttempts;
      delete (order as any).deliveryCodeUsedAt;
    }

    return { data: order };
  }

  async updateOrderStatus(orderId: string, userId: string, dto: UpdateOrderStatusDto) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

    if (dto.status === 'IN_PREPARATION' && order.scheduledDeliveryAt) {
      const scheduledDay = new Date(
        order.scheduledDeliveryAt.getFullYear(),
        order.scheduledDeliveryAt.getMonth(),
        order.scheduledDeliveryAt.getDate(),
      );
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (scheduledDay > today) {
        throw new BadRequestException(
          `Préparation possible à partir du ${order.scheduledDeliveryAt.toLocaleDateString('fr-FR')}`,
        );
      }
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: dto.status as any,
        ...(dto.rejectedReason && { rejectedReason: dto.rejectedReason }),
        ...(dto.cancelledReason && { cancelledReason: dto.cancelledReason, cancelledBy: userId }),
      },
    });

    // BUG FIX : la version précédente mappait dto.status -> 'ORDER_*' puis
    // passait cette string custom à sendOrderNotification(). Or ce dernier
    // matche sur les STATUS réels (ACCEPTED, IN_PREPARATION, …) dans son
    // dict statusMessages -> tout retombait sur 'undefined' -> aucune notif
    // n'était jamais envoyée. On passe maintenant dto.status direct.
    // 'REJECTED' (status custom du DTO) est mappé sur 'CANCELLED' qui est
    // le seul status FCM destiné au client en cas de refus.
    const fcmStatus = dto.status === 'REJECTED' ? 'CANCELLED' : dto.status;
    await this.notifications.sendOrderNotification(orderId, fcmStatus as any);

    // Sprint B - quand le pro marque READY_FOR_PICKUP, on broadcast aux
    // drivers éligibles. C'est le moment correct dans le workflow métier
    // (avant : on dispatchait à PAID, le driver pouvait arriver chez un
    // pro qui n'avait pas encore préparé/accepté la commande).
    if (dto.status === 'READY_FOR_PICKUP') {
      this.dispatchNewMission(orderId);
    }

    // Sprint C - émet order_status temps réel sur la room order_<id>
    // pour que le client (tracking_screen) ait un statut LIVE sans
    // dépendre du FCM (peu fiable en background iOS).
    this.deliveriesGateway.emitOrderStatus(orderId, dto.status, {
      ...(dto.rejectedReason && { rejectedReason: dto.rejectedReason }),
      ...(dto.cancelledReason && { cancelledReason: dto.cancelledReason }),
    });

    return { data: updated };
  }

  async cancelOrder(orderId: string, clientId: string, reason?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      // Inclut driver.userId pour pouvoir le notifier si déjà assigné.
      include: { driver: { select: { userId: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.clientId !== clientId) throw new ForbiddenException();

    // Deadline d'annulation : config admin (défaut 5 min).
    // Logique corrigée : on BLOQUE l'annulation après deadline SAUF si la
    // commande est encore en statut early (PENDING_PAYMENT/PAID/ACCEPTED).
    // Une fois DRIVER_ASSIGNED ou plus, l'annulation client est interdite
    // pour éviter qu'un driver fasse la course pour rien (-> contact support).
    const config = await this.prisma.platformConfig.findUnique({ where: { key: 'cancellationDeadlineMinutes' } });
    const deadline = (config?.value as any) ?? 5;
    const minutesSinceOrder = (Date.now() - order.createdAt.getTime()) / 60000;
    const cancellableStatuses = ['PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'IN_PREPARATION'];
    if (!cancellableStatuses.includes(order.status)) {
      throw new BadRequestException('Cannot cancel order at this stage');
    }
    if (minutesSinceOrder > deadline) {
      throw new BadRequestException('Cancellation deadline passed');
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' as any, cancelledBy: clientId, cancelledReason: reason },
    });

    // Notifier pro + driver assigné (CANCELLED côté notifications.service
    // gère déjà recipients = [client, pro] mais ne notifie pas le driver
    // tant qu'on ne lui envoie pas explicitement la notif).
    await this.notifications.sendOrderNotification(orderId, 'CANCELLED' as any);

    // Sprint C - emit order_status pour update temps réel UI tracking
    this.deliveriesGateway.emitOrderStatus(orderId, 'CANCELLED', { reason });

    // Si un driver est déjà assigné, lui pousser une notif FCM dédiée
    // pour qu'il arrête sa course. Best-effort, on n'échoue pas le cancel
    // si la notif ne part pas (méthode sendPush gère déjà le no-token).
    if (order.driver?.userId) {
      try {
        await this.notifications.sendPush(
          order.driver.userId,
          'Mission annulée',
          'Le client a annulé la commande. Vous pouvez quitter votre course.',
          { type: 'mission_cancelled', orderId },
        );
      } catch {
        // silencieux : la notif n'est pas critique
      }
    }

    return updated;
  }

  async reorderFromPrevious(orderId: string, clientId: string) {
    const original = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!original || original.clientId !== clientId) throw new ForbiddenException();

    return { data: { prefilled: { professionalId: original.professionalId, items: original.items } } };
  }

  private async applyPromoCode(code: string, _userId: string, subtotal: number): Promise<number> {
    const promo = await this.prisma.promoCode.findUnique({ where: { code } });
    if (!promo || !promo.isActive) throw new BadRequestException('Invalid promo code');
    if (promo.expiresAt && new Date() > promo.expiresAt) throw new BadRequestException('Promo code expired');
    if (subtotal < promo.minOrder) throw new BadRequestException(`Minimum order ${promo.minOrder} required`);

    // Incrément atomique : échoue si maxUses est atteint, évite la race condition.
    // Table réelle : "promo_codes" (@@map dans schema.prisma).
    const updated = await this.prisma.$executeRaw`
      UPDATE "promo_codes" SET "usesCount" = "usesCount" + 1
      WHERE code = ${code}
        AND ("maxUses" IS NULL OR "usesCount" < "maxUses")
    `;
    if (updated === 0) throw new BadRequestException('Promo code limit reached');

    const discount = promo.type === 'PERCENTAGE'
      ? Math.round(subtotal * (promo.value / 100))
      : Number(promo.value);
    return discount;
  }

  async submitTip(clientId: string, orderId: string, amount: number) {
    if (!amount || amount <= 0) throw new BadRequestException('Montant invalide');

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { delivery: true },
    });

    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.clientId !== clientId) throw new ForbiddenException();
    if (order.status !== ('DELIVERED' as any)) throw new BadRequestException('Le pourboire est disponible uniquement après livraison');
    if ((order as any).tipAmount > 0) throw new BadRequestException('Un pourboire a déjà été laissé pour cette commande');
    if (!order.delivery?.driverId) throw new BadRequestException('Aucun livreur associé à cette commande');

    const [updatedOrder] = await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: orderId },
        data: { tipAmount: amount } as any,
      }),
      this.prisma.transaction.create({
        data: {
          driverId: order.delivery.driverId,
          type: 'TIP' as any,
          amount,
          currency: order.currency,
          status: 'COMPLETED' as any,
          orderId,
          description: `Pourboire commande #${orderId.slice(-8).toUpperCase()}`,
        } as any,
      }),
    ]);

    return updatedOrder;
  }

  /**
   * Génère le code de confirmation de livraison (6 caractères par défaut,
   * configurable via platformConfig 'delivery_confirm_code'.digits) dès
   * qu'un livreur est assigné, et l'envoie EXCLUSIVEMENT au client par push
   * — jamais au livreur, qui doit le demander de vive voix à la livraison.
   */
  private async generateAndSendDeliveryCode(orderId: string, clientId: string) {
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'delivery_confirm_code' } });
    const digits = (cfg?.value as any)?.digits ?? 6;
    const code = String(Math.floor(Math.random() * Math.pow(10, digits))).padStart(digits, '0');

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        deliveryCode: code,
        deliveryCodeStatus: 'ACTIVE',
        deliveryCodeAttempts: 0,
        deliveryCodeUsedAt: null,
      } as any,
    });

    this.notifications.sendDeliveryCodePush(clientId, code, orderId).catch(() => {});
  }

  /**
   * Assignation manuelle d'un livreur favori par le professionnel.
   * Déclenché après READY_FOR_PICKUP quand le pro choisit explicitement
   * un de ses livreurs favoris disponibles.
   */
  async assignDriver(orderId: string, driverId: string, proUserId: string) {
    const prof = await this.prisma.professional.findUnique({ where: { userId: proUserId } });
    if (!prof) throw new ForbiddenException();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { professional: { select: { businessName: true, address: true, lat: true, lng: true } } },
    });
    if (!order || order.professionalId !== prof.id) throw new ForbiddenException();
    if (order.status !== 'READY_FOR_PICKUP') {
      throw new BadRequestException('Assignation possible uniquement en statut READY_FOR_PICKUP');
    }

    // Le pro peut assigner un livreur favori qu'il soit en ligne ou non.
    // Reçoit le Driver.id (tel qu'envoyé par la liste favoris mobile), pas
    // le userId — la recherche doit donc se faire par `id`, pas `userId`.
    // ⚠️ status n'est PAS un indicateur fiable d'approbation admin à lui
    // seul : toggleAvailability() l'écrase en 'ONLINE'/'OFFLINE' à chaque
    // bascule (cf. drivers.service.ts). validatedAt est fiable pour les
    // livreurs validés depuis l'ajout de ce champ, mais les plus anciens
    // ont validatedAt=null malgré un statut déjà approuvé — status
    // ONLINE/OFFLINE est un signal complémentaire fiable dans ce cas
    // précis : toggleAvailability() refuse le passage en ligne tant que
    // status='PENDING', donc ONLINE/OFFLINE implique forcément une
    // validation passée, même sans validatedAt renseigné.
    const driver = await this.prisma.driver.findFirst({
      where: {
        id: driverId,
        OR: [
          { validatedAt: { not: null } },
          { status: { in: ['VALIDATED', 'ONLINE', 'OFFLINE'] as any } },
        ],
      },
    });
    if (!driver) throw new NotFoundException('Livreur introuvable ou non validé');
    const driverUserId = driver.userId;

    // Calcul distance + temps estimé (réutilise la même formule que dispatch).
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(order.deliveryLat - (order.professional as any).lat);
    const dLng = toRad(order.deliveryLng - (order.professional as any).lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad((order.professional as any).lat)) *
        Math.cos(toRad(order.deliveryLat)) *
        Math.sin(dLng / 2) ** 2;
    const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const estimatedMinutes = Math.max(10, Math.round(distanceKm * 3 + 5));

    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: orderId },
        data: { driverId: driver.id, status: 'DRIVER_ASSIGNED' as any },
      }),
      this.prisma.delivery.upsert({
        where: { orderId },
        create: { orderId, driverId: driver.id, status: 'ASSIGNED' as any, distanceKm },
        update: { driverId: driver.id, status: 'ASSIGNED' as any, distanceKm },
      }),
    ]);

    await this.generateAndSendDeliveryCode(orderId, order.clientId);

    // Notifie le livreur (socket + FCM push enrichi).
    const pro = order.professional as any;
    const assignDeliveryZone = (order as any).deliveryCity ?? pro.city ?? '';
    this.deliveriesGateway.emitNewMission({
      orderId:             order.id,
      professionalName:    pro.businessName,
      professionalAddress: pro.address,
      professionalPhone:   pro.phone ?? '',
      professionalLat:     pro.lat,
      professionalLng:     pro.lng,
      deliveryAddress:     order.deliveryAddress,
      deliveryZone:        assignDeliveryZone,
      deliveryLat:         order.deliveryLat,
      deliveryLng:         order.deliveryLng,
      deliveryFee:         order.deliveryFee,
      currency:            order.currency,
      distanceKm,
      estimatedMinutes,
      driverUserId,
    });
    this.notifications.sendDriverMissionPush(driverUserId, {
      orderId:            order.id,
      professionalName:   pro.businessName,
      professionalAddress: pro.address,
      deliveryZone:       assignDeliveryZone,
      distanceToPickupKm: null,
      distanceKm,
      deliveryFee:        order.deliveryFee,
      currency:           order.currency,
    }).catch(() => {});
    this.deliveriesGateway.emitOrderStatus(orderId, 'DRIVER_ASSIGNED', { driverId: driver.id });
    this.notifications.sendOrderNotification(orderId, 'DRIVER_ASSIGNED').catch(() => {});

    return { data: { success: true, driverId: driver.id } };
  }

  /**
   * Un livreur "réclame" manuellement une mission via le code que le
   * professionnel lui a communiqué (téléphone, en personne, etc.) — les
   * 8 premiers caractères de l'ID de commande, affichés au pro sous la
   * forme "Commande #ABC12345" (cf. pro_order_detail_screen.dart). Même
   * workflow de notification que l'assignation directe.
   */
  async claimOrderByCode(code: string, driverUserId: string) {
    // validatedAt + status ONLINE/OFFLINE : voir commentaire dans
    // assignDriver() ci-dessus.
    const driver = await this.prisma.driver.findFirst({
      where: {
        userId: driverUserId,
        OR: [
          { validatedAt: { not: null } },
          { status: { in: ['VALIDATED', 'ONLINE', 'OFFLINE'] as any } },
        ],
      },
    });
    if (!driver) throw new ForbiddenException('Profil livreur non validé');

    const normalizedCode = code.trim().toLowerCase();
    if (normalizedCode.length < 4) throw new BadRequestException('Code invalide');

    const order = await this.prisma.order.findFirst({
      where: {
        id: { startsWith: normalizedCode },
        status: 'READY_FOR_PICKUP' as any,
        driverId: null,
      },
      include: { professional: { select: { businessName: true, address: true, phone: true, lat: true, lng: true } } },
    });
    if (!order) throw new NotFoundException('Aucune commande disponible avec ce code');

    // Claim atomique : le guard driverId:null empêche deux livreurs de
    // prendre la même commande si le pro a partagé le code deux fois.
    const claimed = await this.prisma.order.updateMany({
      where: { id: order.id, driverId: null },
      data: { driverId: driver.id, status: 'DRIVER_ASSIGNED' as any },
    });
    if (claimed.count === 0) throw new BadRequestException('Cette commande vient d\'être prise par un autre livreur');

    const pro = order.professional as any;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(order.deliveryLat - pro.lat);
    const dLng = toRad(order.deliveryLng - pro.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(pro.lat)) * Math.cos(toRad(order.deliveryLat)) * Math.sin(dLng / 2) ** 2;
    const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    await this.generateAndSendDeliveryCode(order.id, order.clientId);

    await this.prisma.delivery.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, driverId: driver.id, status: 'ASSIGNED' as any, distanceKm },
      update: { driverId: driver.id, status: 'ASSIGNED' as any, distanceKm },
    });

    // Même workflow de notification que assignDriver() : socket temps réel
    // + push FCM au livreur (canal mission), et notif client/pro standard.
    const deliveryZone = (order as any).deliveryCity ?? pro.city ?? '';
    this.deliveriesGateway.emitNewMission({
      orderId:             order.id,
      professionalName:    pro.businessName,
      professionalAddress: pro.address,
      professionalPhone:   pro.phone ?? '',
      professionalLat:     pro.lat,
      professionalLng:     pro.lng,
      deliveryAddress:     order.deliveryAddress,
      deliveryZone,
      deliveryLat:         order.deliveryLat,
      deliveryLng:         order.deliveryLng,
      deliveryFee:         order.deliveryFee,
      currency:            order.currency,
      distanceKm,
      estimatedMinutes:    Math.max(10, Math.round(distanceKm * 3 + 5)),
      driverUserId,
    });
    this.notifications.sendDriverMissionPush(driverUserId, {
      orderId:            order.id,
      professionalName:   pro.businessName,
      professionalAddress: pro.address,
      deliveryZone,
      distanceToPickupKm: null,
      distanceKm,
      deliveryFee:        order.deliveryFee,
      currency:           order.currency,
    }).catch(() => {});
    this.deliveriesGateway.emitOrderStatus(order.id, 'DRIVER_ASSIGNED', { driverId: driver.id });
    this.notifications.sendOrderNotification(order.id, 'DRIVER_ASSIGNED').catch(() => {});

    return { data: { success: true, orderId: order.id, driverId: driver.id } };
  }
}
