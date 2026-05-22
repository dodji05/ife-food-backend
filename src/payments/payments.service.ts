import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from './gateways/stripe.service';
import { PaypalService } from './gateways/paypal.service';
import { KkiapayService } from './gateways/kkiapay.service';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';
import { DeliveriesGateway } from '../deliveries/deliveries.gateway';

export enum PaymentGatewayName {
  STRIPE = 'STRIPE',
  PAYPAL = 'PAYPAL',
  KKIAPAY = 'KKIAPAY',
  FEDAPAY = 'FEDAPAY',
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
}

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private stripe: StripeService,
    private paypal: PaypalService,
    private kkiapay: KkiapayService,
    private config: ConfigService,
    private notifications: NotificationsService,
    private deliveriesGateway: DeliveriesGateway,
  ) {}

  /**
   * Construit le payload Mission et broadcast `new_mission` à tous les
   * drivers en ligne. Méthode best-effort : tout throw est avalé pour ne
   * pas casser le flow paiement.
   */
  private async dispatchNewMission(orderId: string) {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          professional: { select: { businessName: true, address: true, lat: true, lng: true } },
          items: { include: { product: true } },
        },
      });
      if (!order) return;

      // Distance haversine (km) prof -> client
      const toRad = (d: number) => (d * Math.PI) / 180;
      const R = 6371;
      const dLat = toRad(order.deliveryLat - order.professional.lat);
      const dLng = toRad(order.deliveryLng - order.professional.lng);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(order.professional.lat)) *
          Math.cos(toRad(order.deliveryLat)) *
          Math.sin(dLng / 2) ** 2;
      const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      // Estimation : 3 min/km + 5 min buffer (calibrable plus tard).
      const estimatedMinutes = Math.max(10, Math.round(distanceKm * 3 + 5));

      this.deliveriesGateway.emitNewMission({
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
      });
    } catch {
      /* silencieux : la mission sera de toute façon récupérable via REST */
    }
  }

  async initiatePayment(orderId: string, gateway: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { client: true } });
    if (!order) throw new NotFoundException('Order not found');

    const gw = gateway.toUpperCase() as PaymentGatewayName;
    let paymentData: any;

    switch (gw) {
      case PaymentGatewayName.STRIPE:
        paymentData = await this.stripe.createPaymentIntent(order.totalAmount, order.currency, orderId);
        break;
      case PaymentGatewayName.PAYPAL:
        paymentData = await this.paypal.createOrder(order.totalAmount, order.currency, orderId);
        break;
      case PaymentGatewayName.KKIAPAY:
        paymentData = await this.kkiapay.initiatePayment(order.totalAmount, order.currency, orderId, order.client.phone);
        break;
      case PaymentGatewayName.CASH_ON_DELIVERY: {
        // Vérifie que COD est activé dans la config plateforme
        const platformCfg = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentGateways' } });
        const gateways = (platformCfg?.value as any) ?? {};
        if (gateways.CASH_ON_DELIVERY === false) throw new BadRequestException('Le paiement à la livraison n\'est pas disponible');
        // Pas de passerelle en ligne — l'ordre est confirmé immédiatement.
        // Le paiement réel est collecté par le livreur à la livraison.
        await this.prisma.payment.upsert({
          where: { orderId },
          update: { status: 'PENDING' as any },
          create: { orderId, gateway: 'CASH_ON_DELIVERY' as any, amount: order.totalAmount, currency: order.currency, gatewayRef: `cod_${orderId}`, status: 'PENDING' as any },
        });
        await this.confirmPayment(orderId, `cod_${orderId}`);
        return { data: { method: 'CASH_ON_DELIVERY', orderId } };
      }
      default:
        throw new BadRequestException(`Gateway ${gateway} not supported`);
    }

    await this.prisma.payment.upsert({
      where: { orderId },
      update: { gatewayRef: paymentData.id, gatewayData: paymentData },
      create: { orderId, gateway: gateway as any, amount: order.totalAmount, currency: order.currency, gatewayRef: paymentData.id, gatewayData: paymentData },
    });

    return { data: paymentData };
  }

  async handleWebhook(gateway: string, payload: any, signature: string) {
    let event: any;
    const gw = gateway.toUpperCase() as PaymentGatewayName;
    switch (gw) {
      case PaymentGatewayName.STRIPE:
        event = await this.stripe.constructEvent(payload, signature);
        if (event.type === 'payment_intent.succeeded') await this.confirmPayment(event.data.object.metadata.orderId, event.data.object.id);
        if (event.type === 'payment_intent.payment_failed') await this.failPayment(event.data.object.metadata.orderId);
        break;
      case PaymentGatewayName.KKIAPAY:
        if (payload.status === 'SUCCESS') await this.confirmPayment(payload.reason, payload.transactionId);
        break;
    }
    return { received: true };
  }

  async confirmPayment(orderId: string, gatewayRef: string) {
    await this.prisma.$transaction([
      this.prisma.payment.update({ where: { orderId }, data: { status: 'SUCCESS' as any, gatewayRef } }),
      this.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'SUCCESS' as any, status: 'PAID' as any } }),
    ]);

    // Notification PAID -> envoyée au pro pour qu'il sache qu'une nouvelle
    // commande l'attend (déclencheur clé du workflow pro côté mobile).
    // Best-effort : on n'attend PAS un éventuel throw — un push raté ne doit
    // pas faire échouer la confirmation du paiement webhook (sinon Stripe
    // rejouera le webhook indéfiniment).
    this.notifications.sendOrderNotification(orderId, 'PAID').catch(() => {
      /* déjà loggé dans NotificationsService */
    });

    // Sprint B - dispatch driver déplacé de PAID -> READY_FOR_PICKUP
    // (cf OrdersService.updateOrderStatus). Le pro doit d'abord accepter
    // la commande et la préparer avant qu'un livreur soit cherché.
    // En mode test PRO_AUTO_ACCEPT=true, le bypass est dans createOrder
    // (n'a pas lieu d'être ici car le webhook réel implique un vrai pro).

    // Sprint 7 - récompense parrainage best-effort (ne bloque pas le paiement)
    this.prisma.order
      .findUnique({ where: { id: orderId }, select: { clientId: true } })
      .then(o => { if (o) this.grantReferralReward(o.clientId).catch(() => {}); })
      .catch(() => {});
  }

  private async grantReferralReward(clientId: string): Promise<void> {
    const paidStatuses = ['PAID','ACCEPTED','IN_PREPARATION','READY_FOR_PICKUP','DRIVER_ASSIGNED','PICKED_UP','IN_DELIVERY','DELIVERED'];
    const orderCount = await this.prisma.order.count({ where: { clientId, status: { in: paidStatuses as any[] } } });
    if (orderCount > 1) return;

    const referral = await this.prisma.referral.findUnique({ where: { refereeId: clientId } });
    if (!referral || referral.status !== 'PENDING') return;

    const [enabledCfg, amountCfg] = await Promise.all([
      this.prisma.platformConfig.findUnique({ where: { key: 'referral_enabled' } }),
      this.prisma.platformConfig.findUnique({ where: { key: 'referral_reward_amount' } }),
    ]);
    if (enabledCfg && enabledCfg.value === false) return;
    const amount = amountCfg ? Number(amountCfg.value) : 500;
    if (amount <= 0) return;

    let wallet = await this.prisma.wallet.findUnique({ where: { userId: referral.referrerId } });
    if (!wallet) wallet = await this.prisma.wallet.create({ data: { userId: referral.referrerId, balance: 0 } });

    await this.prisma.$transaction([
      this.prisma.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: amount } } }),
      this.prisma.walletTransaction.create({ data: { walletId: wallet.id, amount, type: 'REFERRAL_REWARD' as any, description: 'Récompense parrainage' } }),
      this.prisma.referral.update({ where: { id: referral.id }, data: { status: 'REWARDED' as any, rewardedAt: new Date() } }),
    ]);
  }

  async failPayment(orderId: string) {
    await this.prisma.payment.update({ where: { orderId }, data: { status: 'FAILED' as any } });
  }

  async refundPayment(orderId: string, amount?: number) {
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (!payment) throw new NotFoundException('Payment not found');

    const refundAmount = amount ?? payment.amount;

    if (payment.gateway === 'STRIPE' && payment.gatewayRef) {
      await this.stripe.refund(payment.gatewayRef, refundAmount);
    }

    await this.prisma.payment.update({ where: { orderId }, data: { status: 'REFUNDED' as any, refundedAt: new Date(), refundAmount } });
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' as any } });
  }

  async getActiveGateways() {
    const config = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentGateways' } });
    return { data: config?.value ?? { STRIPE: true, PAYPAL: true, KKIAPAY: true, FEDAPAY: true } };
  }
}
