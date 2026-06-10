import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export interface StripeCreds {
  secretKey?:      string;
  publishableKey?: string;
  webhookSecret?:  string;
  sandbox?:        boolean;
}

@Injectable()
export class StripeService {
  constructor(private config: ConfigService) {}

  /** Instancie un client Stripe avec la clé DB ou le fallback env. */
  private getClient(creds?: StripeCreds): Stripe {
    const key = creds?.secretKey || this.config.get('STRIPE_SECRET_KEY', '');
    if (!key) throw new BadRequestException('Stripe non configuré — clé secrète manquante');
    return new Stripe(key, { apiVersion: '2023-08-16' });
  }

  /** Clé publishable (mobile) — exposée au client pour la PaymentSheet. */
  getPublishableKey(creds?: StripeCreds): string {
    return creds?.publishableKey || this.config.get('STRIPE_PUBLISHABLE_KEY', '');
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    orderId: string,
    creds?: StripeCreds,
  ) {
    return this.getClient(creds).paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency: currency.toLowerCase(),
      metadata: { orderId },
      automatic_payment_methods: { enabled: true },
    });
  }

  async constructEvent(
    payload: Buffer | string,
    signature: string,
    creds?: StripeCreds,
  ) {
    const secret = creds?.webhookSecret || this.config.get('STRIPE_WEBHOOK_SECRET', '');
    try {
      return this.getClient(creds).webhooks.constructEvent(payload, signature, secret);
    } catch {
      throw new BadRequestException('Invalid Stripe webhook signature');
    }
  }

  /** Statut d'un PaymentIntent. */
  async retrievePaymentIntentStatus(
    paymentIntentId: string,
    creds?: StripeCreds,
  ): Promise<string> {
    const pi = await this.getClient(creds).paymentIntents.retrieve(paymentIntentId);
    return pi.status;
  }

  async refund(
    paymentIntentId: string,
    amount: number,
    creds?: StripeCreds,
  ) {
    return this.getClient(creds).refunds.create({
      payment_intent: paymentIntentId,
      amount: Math.round(amount * 100),
    });
  }
}
