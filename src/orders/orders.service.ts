import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GeoService } from '../geo/geo.service';
import { CreateOrderDto, UpdateOrderStatusDto } from './dto/order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private geo: GeoService,
  ) {}

  async createOrder(clientId: string, dto: CreateOrderDto) {
    // Charger tous les produits en une seule requête (évite le pattern N+1)
    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const items = dto.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product || !product.isAvailable) throw new BadRequestException(`Product ${item.productId} unavailable`);
      return { ...item, unitPrice: product.price, totalPrice: product.price * item.quantity, product };
    });

    const subtotal = items.reduce((sum, i) => sum + i.totalPrice, 0);

    // Get commission config
    const commissionConfig = await this.prisma.platformConfig.findUnique({ where: { key: 'commission' } });
    const config = commissionConfig?.value as any;
    let commissionAmount = 0;
    if (config?.type === 'PERCENTAGE') commissionAmount = subtotal * (config.value / 100);
    else if (config?.type === 'FIXED_AMOUNT') commissionAmount = config.value * items.length;

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
          create: items.map((i) => ({
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

    return { data: updated };
  }

  async cancelOrder(orderId: string, clientId: string, reason?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.clientId !== clientId) throw new ForbiddenException();

    // Check cancellation deadline from config
    const config = await this.prisma.platformConfig.findUnique({ where: { key: 'cancellationDeadlineMinutes' } });
    const deadline = (config?.value as any) ?? 5;
    const minutesSinceOrder = (Date.now() - order.createdAt.getTime()) / 60000;
    if (minutesSinceOrder > deadline && ['ACCEPTED','IN_PREPARATION'].includes(order.status)) {
      throw new BadRequestException('Cancellation deadline passed');
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' as any, cancelledBy: clientId, cancelledReason: reason },
    });
  }

  async reorderFromPrevious(orderId: string, clientId: string) {
    const original = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!original || original.clientId !== clientId) throw new ForbiddenException();

    return { data: { prefilled: { professionalId: original.professionalId, items: original.items } } };
  }

  private async applyPromoCode(code: string, userId: string, subtotal: number): Promise<number> {
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
}
