import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class KkiapayService {
  // Un seul endpoint (prod + sandbox) — le mode est passé dans le body.
  // api-sandbox.kkiapay.me retournait 404 : l'API KKiaPay utilise toujours
  // api.kkiapay.me/api/v1 et différencie sandbox via le paramètre mode.
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

    if (!privateKey || privateKey.includes('your_') || privateKey.length < 10) {
      throw new BadRequestException('KKiaPay non configuré — renseignez KKIAPAY_PRIVATE_KEY et KKIAPAY_SECRET');
    }

    try {
      // KKiaPay utilise toujours api.kkiapay.me/api/v1 — le mode sandbox
      // est passé via le paramètre "mode" dans le body (pas via un sous-domaine).
      const { data } = await axios.post(`${this.baseUrl}/payments/request`, {
        amount,
        currency,
        reason: `Order ${orderId}`,
        phone,
        mode: isSandbox ? 'SANDBOX' : 'LIVE',
      }, {
        headers: {
          'x-private-key': privateKey,
          'x-secret-key':  secretKey,
        },
      });
      return data;
    } catch (e: any) {
      const msg = e?.response?.data?.message
        ?? JSON.stringify(e?.response?.data)
        ?? e?.message
        ?? 'Erreur KKiaPay';
      throw new BadRequestException(`KKiaPay: ${msg}`);
    }
  }
}
