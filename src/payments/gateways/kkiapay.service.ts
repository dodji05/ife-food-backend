import { Injectable, BadRequestException } from '@nestjs/common';
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

    const privateKey = overrideConfig?.privateKey || this.config.get('KKIAPAY_PRIVATE_KEY', '');
    const secretKey  = overrideConfig?.secret      || this.config.get('KKIAPAY_SECRET', '');

    // Vérification des clés avant d'appeler l'API
    if (!privateKey || privateKey.includes('your_') || privateKey.length < 10) {
      throw new BadRequestException('KKiaPay non configuré — renseignez KKIAPAY_PRIVATE_KEY et KKIAPAY_SECRET');
    }

    const url = isSandbox ? 'https://api-sandbox.kkiapay.me/api/v1' : this.baseUrl;

    try {
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
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.response?.data ?? e?.message ?? 'Erreur KKiaPay';
      throw new BadRequestException(`KKiaPay: ${msg}`);
    }
  }
}
