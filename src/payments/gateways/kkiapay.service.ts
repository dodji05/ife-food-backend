import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class KkiapayService {
  private baseUrl = 'https://api.kkiapay.me/api/v1';

  constructor(private config: ConfigService) {}

  async initiatePayment(amount: number, currency: string, orderId: string, phone: string) {
    const isSandbox = this.config.get('KKIAPAY_SANDBOX', 'true') === 'true';
    const url = isSandbox ? 'https://api-sandbox.kkiapay.me/api/v1' : this.baseUrl;

    const { data } = await axios.post(`${url}/transactions/init`, {
      amount,
      currency,
      reason: `Order ${orderId}`,
      phone,
      sandbox: isSandbox,
    }, {
      headers: {
        'x-private-key': this.config.get('KKIAPAY_PRIVATE_KEY'),
        'x-secret-key': this.config.get('KKIAPAY_SECRET'),
      },
    });
    return data;
  }
}
