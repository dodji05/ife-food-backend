import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface PaypalCreds {
  clientId?:     string;
  clientSecret?: string;
  sandbox?:      boolean;
}

@Injectable()
export class PaypalService {
  private readonly liveUrl    = 'https://api-m.paypal.com';
  private readonly sandboxUrl = 'https://api-m.sandbox.paypal.com';

  constructor(private config: ConfigService) {}

  private getBaseUrl(creds?: PaypalCreds): string {
    const sandbox = creds?.sandbox !== undefined
      ? creds.sandbox
      // Fallback env — default 'live' pour éviter le sandbox silencieux en prod
      : this.config.get('PAYPAL_MODE', 'live') === 'sandbox';
    return sandbox ? this.sandboxUrl : this.liveUrl;
  }

  private getClientId(creds?: PaypalCreds): string {
    return creds?.clientId || this.config.get('PAYPAL_CLIENT_ID', '');
  }

  private getClientSecret(creds?: PaypalCreds): string {
    return creds?.clientSecret || this.config.get('PAYPAL_CLIENT_SECRET', '');
  }

  private async getAccessToken(creds?: PaypalCreds): Promise<string> {
    const clientId     = this.getClientId(creds);
    const clientSecret = this.getClientSecret(creds);
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'PayPal non configuré : CLIENT_ID et CLIENT_SECRET requis (admin → Paiements)',
      );
    }
    try {
      const { data } = await axios.post(
        `${this.getBaseUrl(creds)}/v1/oauth2/token`,
        'grant_type=client_credentials',
        { auth: { username: clientId, password: clientSecret } },
      );
      if (!data?.access_token) {
        throw new BadRequestException('PayPal OAuth : access_token absent de la réponse');
      }
      return data.access_token;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      const status  = err?.response?.status;
      const details = err?.response?.data?.error_description ?? err?.message ?? '';
      throw new BadRequestException(
        `PayPal OAuth échoué (${status ?? 'réseau'}) : ${details}`,
      );
    }
  }

  /**
   * Devises acceptées par PayPal (liste officielle).
   * XOF et la plupart des devises africaines NE sont PAS supportées.
   */
  static readonly SUPPORTED_CURRENCIES = new Set([
    'AUD','BRL','CAD','CNY','CZK','DKK','EUR','GBP','HKD','HUF',
    'ILS','JPY','MYR','MXN','NOK','NZD','PHP','PLN','SGD','SEK',
    'CHF','TWD','THB','USD',
  ]);

  async createOrder(
    amount: number,
    currency: string,
    orderId: string,
    creds?: PaypalCreds,
    returnUrl?: string,
    cancelUrl?: string,
  ) {
    const token   = await this.getAccessToken(creds);
    const baseUrl = this.getBaseUrl(creds);
    try {
      const { data } = await axios.post(
        `${baseUrl}/v2/checkout/orders`,
        {
          intent: 'CAPTURE',
          purchase_units: [{
            amount:    { currency_code: currency.toUpperCase(), value: amount.toFixed(2) },
            custom_id: orderId,
          }],
          // URLs de retour pour le navigateur in-app
          ...(returnUrl || cancelUrl ? {
            application_context: {
              return_url: returnUrl ?? `${this.config.get('API_URL', '')}/payments/paypal-return`,
              cancel_url: cancelUrl ?? `${this.config.get('API_URL', '')}/payments/paypal-cancel`,
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          } : {}),
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return data;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      const status  = err?.response?.status;
      const details =
        err?.response?.data?.details?.[0]?.description ??
        err?.response?.data?.message ??
        err?.message ?? '';
      throw new BadRequestException(
        `PayPal createOrder échoué (${status ?? 'réseau'}) : ${details}`,
      );
    }
  }

  async captureOrder(paypalOrderId: string, creds?: PaypalCreds) {
    const token = await this.getAccessToken(creds);
    try {
      const { data } = await axios.post(
        `${this.getBaseUrl(creds)}/v2/checkout/orders/${paypalOrderId}/capture`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return data;
    } catch (err: any) {
      // Extraire le code PayPal et le relancer lisiblement pour les appelants
      const paypalData = err?.response?.data;
      const issue      = paypalData?.details?.[0]?.issue ?? paypalData?.name ?? err.message;
      const ex         = new BadRequestException(`PayPal capture: ${issue}`);
      (ex as any).paypalIssue = issue; // attaché pour détection par capturePaypalPayment
      throw ex;
    }
  }
}
