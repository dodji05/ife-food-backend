import { Injectable } from '@nestjs/common';
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
      : this.config.get('PAYPAL_MODE', 'sandbox') !== 'live';
    return sandbox ? this.sandboxUrl : this.liveUrl;
  }

  private getClientId(creds?: PaypalCreds): string {
    return creds?.clientId || this.config.get('PAYPAL_CLIENT_ID', '');
  }

  private getClientSecret(creds?: PaypalCreds): string {
    return creds?.clientSecret || this.config.get('PAYPAL_CLIENT_SECRET', '');
  }

  private async getAccessToken(creds?: PaypalCreds): Promise<string> {
    const { data } = await axios.post(
      `${this.getBaseUrl(creds)}/v1/oauth2/token`,
      'grant_type=client_credentials',
      { auth: { username: this.getClientId(creds), password: this.getClientSecret(creds) } },
    );
    return data.access_token;
  }

  async createOrder(
    amount: number,
    currency: string,
    orderId: string,
    creds?: PaypalCreds,
  ) {
    const token = await this.getAccessToken(creds);
    const { data } = await axios.post(
      `${this.getBaseUrl(creds)}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: currency, value: amount.toFixed(2) },
          custom_id: orderId,
        }],
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return data;
  }

  async captureOrder(paypalOrderId: string, creds?: PaypalCreds) {
    const token = await this.getAccessToken(creds);
    const { data } = await axios.post(
      `${this.getBaseUrl(creds)}/v2/checkout/orders/${paypalOrderId}/capture`,
      {},
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return data;
  }
}
