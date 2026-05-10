import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class PaypalService {
  private baseUrl: string;

  constructor(private config: ConfigService) {
    const mode = config.get('PAYPAL_MODE', 'sandbox');
    this.baseUrl = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  private async getAccessToken(): Promise<string> {
    const { data } = await axios.post(`${this.baseUrl}/v1/oauth2/token`,
      'grant_type=client_credentials',
      { auth: { username: this.config.get('PAYPAL_CLIENT_ID', ''), password: this.config.get('PAYPAL_CLIENT_SECRET', '') } }
    );
    return data.access_token;
  }

  async createOrder(amount: number, currency: string, orderId: string) {
    const token = await this.getAccessToken();
    const { data } = await axios.post(`${this.baseUrl}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: currency, value: amount.toFixed(2) }, custom_id: orderId }],
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return data;
  }

  async captureOrder(paypalOrderId: string) {
    const token = await this.getAccessToken();
    const { data } = await axios.post(`${this.baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return data;
  }
}
