import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GeoService } from '../geo/geo.service';
import { DeliveriesGateway } from '../deliveries/deliveries.gateway';
import { CreateOrderDto, UpdateOrderStatusDto } from './dto/order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private geo: GeoService,
    private config: ConfigService,
    private deliveriesGateway: DeliveriesGateway,
  ) {}

  /**
   * Broadcast `new_mission` aux drivers ÉLIGIBLES.
   *
   * Sprint B - filtrage éligibilité côté backend (best-effort) :
   *   - status='VALIDATED' (driver actif validé par admin)
   *   - isAvailable=true (driver en mode ONLINE)
   *   - quota maxConcurrentDeliveries non atteint
   *   - zone : si driver.zoneCity match l'adresse delivery, on priorise.
   *     Fallback : tous les drivers éligibles si aucun match géo.
   *
   * On émet ensuite individuellement sur la room driver_<userId> pour
   * chaque driver éligible (vs broadcast aveugle sur drivers_online).
   * Coût raisonnable car early stage : <50 drivers concurrents.
   */
  private async dispatchNewMission(orderId: string) {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          professional: { select: { businessName: true, address: true, lat: true, lng: true, city: true } },
          items: { include: { product: true } },
        },
      });
      if (!order) return;

      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(order.deliveryLat - order.professional.lat);
      const dLng = toRad(order.deliveryLng - order.professional.lng);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(order.professional.lat)) *
          Math.cos(toRad(order.deliveryLat)) *
          Math.sin(dLng / 2) ** 2;
      const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const estimatedMinutes = Math.max(10, Math.round(distanceKm * 3 + 5));

      const payload = {
        orderId: order.id,
        professionalName: order.professional.businessName,
        professionalAddress: order.professional.address,
        professionalLat: order.professional.lat,
        professionalLng: order.professional.lng,
        deliveryAddress: order.deliveryAddress,
        deliveryLat: order.deliveryLat,
        deliveryLng: order.deliveryLng,
        deliveryFee: order.deliveryFee,
        currency: order.currency,
        distanceKm,
        estimatedMinutes,
        items: order.items,
      };

      // Récupère les drivers éligibles : validated + available + quota OK.
      // Constante MAX_CONCURRENT_DELIVERIES synchronisée avec drivers.service.ts
      // (aligné sur le mobile Driver.maxConcurrentDeliveries=3).
      const MAX_CONCURRENT_DELIVERIES = 3;
      const eligibleDrivers = await this.prisma.driver.findMany({
        where: {
          status: 'VALIDATED' as any,
          isAvailable: true,
        },
        select: {
          id: true, userId: true, zoneCity: true,
          // Compte les missions actives pour appliquer le filtre quota.
          _count: {
            select: {
              deliveries: {
                where: {
                  status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] as any },
                },
              },
            },
          },
        },
      });

      const available = eligibleDrivers.filter(
        (d) => d._count.deliveries < MAX_CONCURRENT_DELIVERIES);

      if (available.length === 0) {
        this.logger.warn(`[dispatch] Aucun driver éligible pour order ${order.id}`);
        return;
      }

      // Priorise les drivers de la même ville que le restaurant.
      // Fallback : tous les drivers disponibles si aucun match géo.
      const proCity = order.professional.city;
      const sameCity = proCity
        ? available.filter((d) => d.zoneCity && d.zoneCity === proCity)
        : [];
      const targets = sameCity.length > 0 ? sameCity : available;

      this.logger.log(
        `[dispatch] order ${order.id} -> ${targets.length} driver(s) eligible(s)` +
        (sameCity.length > 0 ? ` (zone ${proCity})` : ' (tous, pas de match zone)'));

      // Émission ciblée sur la room individuelle de chaque driver.
      for (const d of targets) {
        this.deliveriesGateway.emitNewMission({ ...payload, driverUserId: d.userId });
      }
    } catch (e) {
      this.logger.error(`[dispatch] Erreur: ${e}`);
    }
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

    let commissionAmount = 0;
    let orderItems = baseItems;

    if (proCfg?.type === 'PERCENTAGE') {
      const baseSubtotal = baseItems.reduce((sum, i) => sum + i.totalPrice, 0);
      commissionAmount = baseSubtotal * (Number(proCfg.value) / 100);
      // unitPrice = base price; subtotal = base price sum
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
    const deliveryFee = await this.geo.calculateDeliveryFee(
      professional.lat, professional.lng,
      dto.deliveryLat, dto.deliveryLng,
      professional.city, dto.deliveryCity,
    );

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
      // Sprint C - emit PAID sur la room order_<id>. Le tracking_screen
      // client commence à écouter dès qu'il s'ouvre, donc cet event lui
      // permet de voir le statut bouger en mode test.
      this.deliveriesGateway.emitOrderStatus(order.id, 'PAID');

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
        include: { professional: { select: { businessName: true, logoUrl: true } }, items: true },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.order.count({ where: { clientId } }),
    ]);
    return { data: orders, meta: { total, page: pagination.page, limit: pagination.limit } };
  }

  async getProfessionalOrders(professionalId: string, pagination: PaginationDto) {
    // Relations enrichies pour la vue PRO :
    //   - client : nom + tel + avatar (bouton appel + avatar carte)
    //   - driver.user : nom + tel + avatar (bandeau livreur assigné)
    //   - items.product : nom multilingue + imageUrl (thumbnail item)
    //   - payment : statut paiement (badge optionnel)
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { professionalId },
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
      this.prisma.order.count({ where: { professionalId } }),
    ]);
    return { data: orders, meta: { total, page: pagination.page, limit: pagination.limit } };
  }

  async getOrderById(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: true } },
        client: { select: { name: true, firstName: true, phone: true, avatarUrl: true } },
        professional: { select: { businessName: true, address: true, phone: true, lat: true, lng: true } },
        // `phone` ajouté : le mobile PRO affiche un bouton "Appeler le livreur"
        // depuis le détail de commande, donc le tel est requis dans la réponse.
        driver: { include: { user: { select: { name: true, firstName: true, phone: true, avatarUrl: true } } } },
        delivery: true,
        payment: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.clientId !== userId && order.professionalId !== userId && order.driverId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return { data: order };
  }

  async updateOrderStatus(orderId: string, userId: string, dto: UpdateOrderStatusDto) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

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

    // Incrément atomique : échoue si maxUses est atteint, évite la race condition
    const updated = await this.prisma.$executeRaw`
      UPDATE "PromoCode" SET "usesCount" = "usesCount" + 1
      WHERE code = ${code}
        AND ("maxUses" IS NULL OR "usesCount" < "maxUses")
    `;
    if (updated === 0) throw new BadRequestException('Promo code limit reached');

    const discount = promo.type === 'PERCENTAGE' ? subtotal * (promo.value / 100) : promo.value;
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
}
