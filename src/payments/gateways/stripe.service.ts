import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor(private config: ConfigService) {
    this.stripe = new Stripe(config.get('STRIPE_SECRET_KEY', ''), { apiVersion: '2023-08-16' });
  }

  /** Clé publishable (mobile) — exposée au client pour la PaymentSheet. */
  getPublishableKey(override?: string): string {
    return override || this.config.get('STRIPE_PUBLISHABLE_KEY', '');
  }

  async createPaymentIntent(amount: number, currency: string, orderId: string) {
    return this.stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency: currency.toLowerCase(),
      metadata: { orderId },
      automatic_payment_methods: { enabled: true },
    });
  }

  async constructEvent(payload: Buffer | string, signature: string) {
    try {
      return this.stripe.webhooks.constructEvent(payload, signature, this.config.get('STRIPE_WEBHOOK_SECRET', ''));
    } catch {
      throw new BadRequestException('Invalid Stripe webhook signature');
    }
  }

  /** Statut d'un PaymentIntent : succeeded | processing | requires_* | canceled. */
  async retrievePaymentIntentStatus(paymentIntentId: string): Promise<string> {
    const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId);
    return pi.status;
  }

  async refund(paymentIntentId: string, amount: number) {
    return this.stripe.refunds.create({ payment_intent: paymentIntentId, amount: Math.round(amount * 100) });
  }
}
