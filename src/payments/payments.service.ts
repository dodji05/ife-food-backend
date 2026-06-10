import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from './gateways/stripe.service';
import { PaypalService } from './gateways/paypal.service';
import { KkiapayService } from './gateways/kkiapay.service';
import { FedapayService } from './gateways/fedapay.service';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';
import { DeliveriesGateway } from '../deliveries/deliveries.gateway';
import { GeoService } from '../geo/geo.service';

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
    private fedapay: FedapayService,
    private config: ConfigService,
    private notifications: NotificationsService,
    private deliveriesGateway: DeliveriesGateway,
    private geo: GeoService,
  ) {}

  private async loadGatewayCredentials(): Promise<any> {
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentCredentials' } });
    return (cfg?.value as any) ?? {};
  }

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
    const dbCreds = await this.loadGatewayCredentials();

    switch (gw) {
      case PaymentGatewayName.STRIPE: {
        const intent = await this.stripe.createPaymentIntent(order.totalAmount, order.currency, orderId, dbCreds.STRIPE);
        const publishableKey = this.stripe.getPublishableKey(dbCreds.STRIPE);
        await this.prisma.payment.upsert({
          where: { orderId },
          update: { gatewayRef: intent.id, gatewayData: intent as any, status: 'PENDING' as any },
          create: { orderId, gateway: 'STRIPE' as any, amount: order.totalAmount, currency: order.currency, gatewayRef: intent.id, gatewayData: intent as any, status: 'PENDING' as any },
        });
        // Réponse structurée pour la PaymentSheet mobile (flutter_stripe).
        return {
          data: {
            method:         'STRIPE',
            stripe:         true,
            orderId,
            clientSecret:   intent.client_secret,
            publishableKey,
            amount:         order.totalAmount,
            currency:       order.currency,
          },
        };
      }
      case PaymentGatewayName.PAYPAL: {
        const apiUrl    = this.config.get('API_URL', '');
        const returnUrl = `${apiUrl}/payments/paypal-return`;
        const cancelUrl = `${apiUrl}/payments/paypal-cancel`;

        // ── Conversion de devise si XOF/XAF/GNF… non supporté par PayPal ──
        const orderCurrency = order.currency.toUpperCase();
        let paypalAmount   = Number(order.totalAmount);
        let paypalCurrency = orderCurrency;

        if (!PaypalService.SUPPORTED_CURRENCIES.has(orderCurrency)) {
          // Devise cible : configurée dans les creds PayPal (admin), sinon USD
          paypalCurrency = (dbCreds.PAYPAL?.convertToCurrency ?? 'USD').toUpperCase();
          const rate = await this.geo.getExchangeRate(orderCurrency, paypalCurrency);
          // Arrondi au centime supérieur pour ne jamais sous-capturer
          paypalAmount = Math.ceil(Number(order.totalAmount) * rate * 100) / 100;
        }

        const paypalOrder = await this.paypal.createOrder(
          paypalAmount, paypalCurrency, orderId, dbCreds.PAYPAL, returnUrl, cancelUrl,
        );
        // Extraire l'URL d'approbation depuis links[rel='approve']
        const approvalLink = (paypalOrder.links as any[])?.find((l: any) => l.rel === 'approve');
        const approvalUrl  = approvalLink?.href ?? null;

        await this.prisma.payment.upsert({
          where:  { orderId },
          update: {
            gatewayRef: paypalOrder.id,
            gatewayData: {
              ...paypalOrder,
              // Traçabilité : on garde le montant original de la commande
              _originalCurrency: order.currency,
              _originalAmount:   Number(order.totalAmount),
              _paypalCurrency:   paypalCurrency,
              _paypalAmount:     paypalAmount,
            },
            status: 'PENDING' as any,
          },
          create: {
            orderId, gateway: 'PAYPAL' as any,
            amount: order.totalAmount, currency: order.currency,
            gatewayRef: paypalOrder.id,
            gatewayData: {
              ...paypalOrder,
              _originalCurrency: order.currency,
              _originalAmount:   Number(order.totalAmount),
              _paypalCurrency:   paypalCurrency,
              _paypalAmount:     paypalAmount,
            },
            status: 'PENDING' as any,
          },
        });
        return {
          data: {
            method:          'PAYPAL',
            paypal:          true,
            orderId,
            paypalOrderId:   paypalOrder.id,
            approvalUrl,
            amount:          order.totalAmount,
            currency:        order.currency,
            // Infos de conversion pour affichage mobile (optionnel)
            ...(paypalCurrency !== orderCurrency && {
              paypalAmount:   paypalAmount,
              paypalCurrency: paypalCurrency,
            }),
          },
        };
      }
      case PaymentGatewayName.KKIAPAY: {
        const platformCfg = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentGateways' } });
        const gateways = (platformCfg?.value as any) ?? {};
        if (gateways.KKIAPAY === false) throw new BadRequestException('KKiaPay n\'est pas disponible');
        // KKiaPay n'a pas d'initiation serveur : on crée un paiement PENDING
        // et on renvoie la config publique au widget mobile, qui collectera le
        // paiement puis renverra un transactionId à vérifier (verifyKkiapayPayment).
        const pub = this.kkiapay.getPublicConfig(dbCreds.KKIAPAY);
        if (!pub.publicKey) throw new BadRequestException('Clé publique KKiaPay manquante (KKIAPAY_PUBLIC_KEY)');
        await this.prisma.payment.upsert({
          where: { orderId },
          update: { status: 'PENDING' as any },
          create: { orderId, gateway: 'KKIAPAY' as any, amount: order.totalAmount, currency: order.currency, gatewayRef: `kkiapay_pending_${orderId}`, status: 'PENDING' as any },
        });
        return {
          data: {
            method:    'KKIAPAY',
            widget:    true,           // signale au mobile d'ouvrir le widget natif
            orderId,
            publicKey: pub.publicKey,
            sandbox:   pub.sandbox,
            amount:    order.totalAmount,
            phone:     order.client.phone,
            name:      order.client.name ?? order.client.phone,
            email:     order.client.email,
            currency:  order.currency,
          },
        };
      }
      case PaymentGatewayName.FEDAPAY: {
        const platformCfg = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentGateways' } });
        const gateways = (platformCfg?.value as any) ?? {};
        if (gateways.FEDAPAY === false) throw new BadRequestException('FedaPay n\'est pas disponible');
        paymentData = await this.fedapay.createTransaction(
          order.totalAmount,
          order.currency,
          orderId,
          { name: order.client.name ?? order.client.phone, email: order.client.email, phone: order.client.phone },
          dbCreds.FEDAPAY,
        );
        break;
      }
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

  async handleWebhook(gateway: string, payload: any, rawBody: any, signature: string) {
    let event: any;
    const gw = gateway.toUpperCase() as PaymentGatewayName;
    switch (gw) {
      case PaymentGatewayName.STRIPE: {
        // Stripe constructEvent a besoin du rawBody (Buffer/string) pour sa propre vérif HMAC.
        const stripeCreds = await this.loadGatewayCredentials();
        event = await this.stripe.constructEvent(rawBody, signature, stripeCreds.STRIPE);
      }
        if (event.type === 'payment_intent.succeeded') await this.confirmPayment(event.data.object.metadata.orderId, event.data.object.id);
        if (event.type === 'payment_intent.payment_failed') await this.failPayment(event.data.object.metadata.orderId);
        break;
      case PaymentGatewayName.KKIAPAY:
        if (payload.status === 'SUCCESS') await this.confirmPayment(payload.reason, payload.transactionId);
        break;
      case PaymentGatewayName.FEDAPAY: {
        const dbCreds = await this.loadGatewayCredentials();
        // rawBody (Buffer) pour le HMAC, payload (objet parsé) pour les données.
        if (signature && !this.fedapay.verifySignature(rawBody, signature, dbCreds.FEDAPAY)) break;
        const eventName: string = payload?.name ?? '';
        const tx = payload?.data?.object;
        const orderId: string | undefined = tx?.custom_metadata?.orderId;
        if (!orderId) break;
        if (eventName === 'transaction.approved') {
          await this.confirmPayment(orderId, String(tx.id));
        } else if (eventName === 'transaction.declined' || eventName === 'transaction.canceled') {
          await this.failPayment(orderId);
        }
        break;
      }
      case PaymentGatewayName.PAYPAL: {
        // PayPal envoie event_type + resource
        const eventType: string = payload?.event_type ?? '';
        if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
          // resource.custom_id = notre orderId (défini dans purchase_units[0].custom_id)
          const orderId: string | undefined =
            payload?.resource?.custom_id ??
            payload?.resource?.purchase_units?.[0]?.custom_id;
          const captureId: string | undefined = payload?.resource?.id;
          if (orderId && captureId) {
            await this.confirmPayment(orderId, captureId).catch(() => {/* idempotent */});
          }
        } else if (
          eventType === 'PAYMENT.CAPTURE.DENIED' ||
          eventType === 'PAYMENT.CAPTURE.DECLINED'
        ) {
          const orderId: string | undefined =
            payload?.resource?.custom_id ??
            payload?.resource?.purchase_units?.[0]?.custom_id;
          if (orderId) await this.failPayment(orderId).catch(() => {});
        } else if (eventType === 'CHECKOUT.ORDER.APPROVED') {
          // L'utilisateur a approuvé — on déclenche la capture immédiatement
          const paypalOrderId: string | undefined = payload?.resource?.id;
          const orderId: string | undefined =
            payload?.resource?.purchase_units?.[0]?.custom_id;
          if (orderId && paypalOrderId) {
            await this.capturePaypalPayment(orderId).catch(() => {/* best-effort */});
          }
        }
        break;
      }
    }
    return { received: true };
  }

  /**
   * Capture un paiement PayPal après approbation par l'utilisateur.
   * Appelé depuis le mobile (POST /payments/:orderId/capture-paypal)
   * ET depuis le webhook CHECKOUT.ORDER.APPROVED.
   * Idempotent : retourne SUCCESS si déjà capturé.
   */
  async capturePaypalPayment(orderId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (!payment || (payment.gateway as string) !== 'PAYPAL') {
      throw new BadRequestException('Aucun paiement PayPal trouvé pour cette commande');
    }
    // Idempotence — déjà confirmé
    if ((payment.status as string) === 'SUCCESS') {
      return { data: { status: 'SUCCESS', alreadyConfirmed: true } };
    }

    const paypalOrderId = payment.gatewayRef;
    if (!paypalOrderId) throw new BadRequestException('PayPal order ID introuvable');

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

    const dbCreds = await this.loadGatewayCredentials();
    try {
      const capture = await this.paypal.captureOrder(paypalOrderId, dbCreds.PAYPAL);

      // Validation du montant capturé vs montant attendu (anti-manipulation)
      const capturedValue = Number(
        capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ?? 0,
      );
      const expectedValue = Number(order.totalAmount);
      if (capturedValue > 0 && capturedValue < expectedValue - 0.01) {
        await this.failPayment(orderId).catch(() => {});
        return { data: { status: 'FAILED', reason: 'amount_mismatch' } };
      }

      // Vérification du statut de capture (peut être PENDING si sous revue)
      const captureStatus: string =
        capture?.purchase_units?.[0]?.payments?.captures?.[0]?.status ?? capture?.status ?? '';
      if (captureStatus && captureStatus !== 'COMPLETED') {
        // PENDING = sous revue PayPal — on n'échoue pas, on attend le webhook
        return { data: { status: 'PENDING', captureStatus } };
      }

      const captureId: string =
        capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? paypalOrderId;
      await this.confirmPayment(orderId, captureId);
      return { data: { status: 'SUCCESS' } };
    } catch (e: any) {
      // Idempotence : PayPal signale que l'ordre est déjà capturé
      if ((e as any).paypalIssue === 'ORDER_ALREADY_CAPTURED') {
        await this.confirmPayment(orderId, paypalOrderId).catch(() => {});
        return { data: { status: 'SUCCESS', alreadyConfirmed: true } };
      }
      await this.failPayment(orderId).catch(() => {});
      throw e;
    }
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

    // Commission pro — enregistrée dès le paiement (best-effort, ne bloque pas)
    this.applyProCommissionOnPayment(orderId).catch(() => {});
  }

  /**
   * Crée les transactions PAYOUT (pro) et COMMISSION (plateforme) dès que le
   * paiement est confirmé. Le PAYOUT reste PENDING jusqu'au versement admin.
   * La DELIVERY_FEE du livreur est créée séparément à la livraison.
   */
  private async applyProCommissionOnPayment(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;
    if (!order.commissionAmount && order.commissionAmount !== 0) return;

    // Éviter les doublons si le webhook est rejoué
    const existing = await this.prisma.transaction.findFirst({
      where: { OR: [
        { type: 'PAYOUT' as any,     description: { contains: orderId } },
        { type: 'COMMISSION' as any, description: { contains: orderId } },
      ]},
    });
    if (existing) return;

    const profAmount = Number(order.subtotal) - Number(order.commissionAmount);

    await this.prisma.$transaction([
      // Revenu net du professionnel (en attente de versement)
      this.prisma.transaction.create({
        data: {
          professionalId: order.professionalId,
          type:           'PAYOUT' as any,
          amount:         profAmount,
          currency:       order.currency,
          status:         'PENDING' as any,
          description:    `Revenue for order ${orderId}`,
        },
      }),
      // Commission plateforme (enregistrée et acquise)
      this.prisma.transaction.create({
        data: {
          type:        'COMMISSION' as any,
          amount:      Number(order.commissionAmount),
          currency:    order.currency,
          status:      'COMPLETED' as any,
          description: `Commission for order ${orderId}`,
        },
      }),
    ]);
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

  /**
   * Interroge FedaPay directement pour vérifier si la transaction est approuvée.
   * Utilisé par le client quand le webhook est absent/lent.
   */
  async checkFedapayPayment(orderId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (!payment || (payment.gateway as string) !== 'FEDAPAY') {
      throw new BadRequestException('Aucun paiement FedaPay trouvé pour cette commande');
    }
    if ((payment.status as string) === 'SUCCESS') {
      return { data: { status: 'SUCCESS', alreadyConfirmed: true } };
    }

    const rawId = payment.gatewayRef?.replace('fedapay_', '');
    const transactionId = rawId ? Number(rawId) : NaN;
    if (!rawId || isNaN(transactionId)) {
      throw new BadRequestException('ID de transaction FedaPay introuvable');
    }

    const dbCreds = await this.loadGatewayCredentials();
    const status = await this.fedapay.checkTransactionStatus(transactionId, dbCreds.FEDAPAY);

    if (status === 'approved' || status === 'transferred') {
      await this.confirmPayment(orderId, payment.gatewayRef);
      return { data: { status: 'SUCCESS' } };
    }
    if (status === 'declined' || status === 'canceled') {
      await this.failPayment(orderId);
      return { data: { status: 'FAILED' } };
    }
    return { data: { status: 'PENDING' } };
  }

  /**
   * Vérifie une transaction KKiaPay (transactionId renvoyé par le widget mobile)
   * et confirme la commande si le paiement est SUCCESS.
   */
  async verifyKkiapayPayment(orderId: string, transactionId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (!payment || (payment.gateway as string) !== 'KKIAPAY') {
      throw new BadRequestException('Aucun paiement KKiaPay trouvé pour cette commande');
    }
    if ((payment.status as string) === 'SUCCESS') {
      return { data: { status: 'SUCCESS', alreadyConfirmed: true } };
    }

    // Mémorise le transactionId pour permettre une re-vérification ultérieure
    // (bouton "J'ai payé" depuis le suivi de commande) même si la 1re échoue.
    const txId = transactionId || (payment.gatewayData as any)?.transactionId;
    if (transactionId) {
      await this.prisma.payment.update({
        where: { orderId },
        data: { gatewayData: { transactionId } as any },
      });
    }
    if (!txId) {
      return { data: { status: 'PENDING', reason: 'no_transaction_id' } };
    }

    const dbCreds = await this.loadGatewayCredentials();
    const result = await this.kkiapay.verifyTransaction(txId, dbCreds.KKIAPAY);

    if (result.status === 'SUCCESS') {
      await this.confirmPayment(orderId, `kkiapay_${txId}`);
      return { data: { status: 'SUCCESS' } };
    }
    if (result.status === 'FAILED') {
      await this.failPayment(orderId);
      return { data: { status: 'FAILED' } };
    }
    return { data: { status: 'PENDING' } };
  }

  /**
   * Vérification unifiée appelée depuis le suivi de commande ("J'ai payé").
   * Détecte la passerelle et délègue à la bonne vérification.
   */
  async checkPayment(orderId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (!payment) throw new BadRequestException('Aucun paiement trouvé pour cette commande');
    const gw = payment.gateway as string;
    if (gw === 'FEDAPAY')  return this.checkFedapayPayment(orderId);
    if (gw === 'KKIAPAY')  return this.verifyKkiapayPayment(orderId, '');
    if (gw === 'PAYPAL')   return this.capturePaypalPayment(orderId);
    if (gw === 'STRIPE') {
      if ((payment.status as string) === 'SUCCESS') {
        return { data: { status: 'SUCCESS', alreadyConfirmed: true } };
      }
      if (!payment.gatewayRef) return { data: { status: 'PENDING' } };
      const stripeCreds = await this.loadGatewayCredentials();
      const status = await this.stripe.retrievePaymentIntentStatus(payment.gatewayRef, stripeCreds.STRIPE);
      if (status === 'succeeded') {
        await this.confirmPayment(orderId, payment.gatewayRef);
        return { data: { status: 'SUCCESS' } };
      }
      if (status === 'canceled') {
        await this.failPayment(orderId);
        return { data: { status: 'FAILED' } };
      }
      return { data: { status: 'PENDING' } };
    }
    // Autres passerelles : on renvoie simplement le statut courant.
    return { data: { status: (payment.status as string) === 'SUCCESS' ? 'SUCCESS' : 'PENDING' } };
  }

  async failPayment(orderId: string) {
    await this.prisma.payment.update({ where: { orderId }, data: { status: 'FAILED' as any } });
  }

  async refundPayment(orderId: string, amount?: number) {
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (!payment) throw new NotFoundException('Payment not found');

    const refundAmount = amount ?? payment.amount;

    if (payment.gateway === 'STRIPE' && payment.gatewayRef) {
      const stripeCreds = await this.loadGatewayCredentials();
      await this.stripe.refund(payment.gatewayRef, refundAmount, stripeCreds.STRIPE);
    }

    await this.prisma.payment.update({ where: { orderId }, data: { status: 'REFUNDED' as any, refundedAt: new Date(), refundAmount } });
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' as any } });
  }

  async getActiveGateways() {
    const config = await this.prisma.platformConfig.findUnique({ where: { key: 'paymentGateways' } });
    return { data: config?.value ?? { KKIAPAY: true, CASH_ON_DELIVERY: true } };
  }
}
