import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class KkiapayService {
  private baseUrl = 'https://api.kkiapay.me/api/v1';

  constructor(private config: ConfigService) {}

  async initiatePayment(
    amount: number, currency: string, orderId: string, phone: string,
    overrideConfig?: { privateKey?: string; secret?: string; sandbox?: boolean },
  ) {
    const isSandbox = overrideConfig?.sandbox !== undefined
      ? overrideConfig.sandbox
      : this.config.get('KKIAPAY_SANDBOX', 'true') === 'true';
    const url = isSandbox ? 'https://api-sandbox.kkiapay.me/api/v1' : this.baseUrl;
    const privateKey = overrideConfig?.privateKey || this.config.get('KKIAPAY_PRIVATE_KEY');
    const secretKey = overrideConfig?.secret || this.config.get('KKIAPAY_SECRET');

    const { data } = await axios.post(`${url}/transactions/init`, {
      amount,
      currency,
      reason: `Order ${orderId}`,
      phone,
      sandbox: isSandbox,
    }, {
      headers: {
        'x-private-key': privateKey,
        'x-secret-key': secretKey,
      },
    });
    return data;
  }
}
