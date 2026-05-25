import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class FedapayService {
  constructor(private config: ConfigService) {}

  private get sandbox(): boolean {
    return this.config.get('FEDAPAY_SANDBOX', 'true') === 'true';
  }

  private get apiBaseUrl(): string {
    return this.sandbox
      ? 'https://sandbox-api.fedapay.com/v1'
      : 'https://api.fedapay.com/v1';
  }

  private get payBaseUrl(): string {
    return this.sandbox
      ? 'https://sandbox-pay.fedapay.com'
      : 'https://pay.fedapay.com';
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.get<string>('FEDAPAY_SECRET_KEY', '')}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Crée une transaction FedaPay et retourne l'URL de paiement hébergée.
   * Flux : POST /transactions → POST /transactions/:id/token → URL checkout.
   */
  async createTransaction(
    amount: number,
    currency: string,
    orderId: string,
    customer: { name?: string; email?: string; phone?: string },
  ) {
    const nameParts = (customer.name ?? 'Client IFE').trim().split(/\s+/);
    const firstname = nameParts[0] || 'Client';
    const lastname  = nameParts.slice(1).join(' ') || 'IFE FOOD';
    const callbackUrl = this.config.get<string>('FEDAPAY_CALLBACK_URL', '');

    // 1. Créer la transaction
    const { data: txData } = await axios.post(
      `${this.apiBaseUrl}/transactions`,
      {
        description: `Commande IFE FOOD – ${orderId}`,
        amount,
        currency: { iso: currency || 'XOF' },
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
        customer: {
          firstname,
          lastname,
          ...(customer.email ? { email: customer.email } : {}),
          ...(customer.phone
            ? { phone_number: { number: customer.phone, country: 'bj' } }
            : {}),
        },
        // custom_metadata permet de retrouver l'orderId dans le webhook
        custom_metadata: { orderId },
      },
      { headers: this.headers },
    );

    // L'API FedaPay retourne soit { v1: { transaction: { id } } } soit { transaction: { id } }
    const transactionId: number =
      txData?.v1?.transaction?.id ?? txData?.transaction?.id ?? txData?.id;

    // 2. Obtenir le token de paiement
    const { data: tokenData } = await axios.post(
      `${this.apiBaseUrl}/transactions/${transactionId}/token`,
      {},
      { headers: this.headers },
    );

    const token: string = tokenData.token;
    const checkoutUrl = `${this.payBaseUrl}/${token}`;

    return {
      id: `fedapay_${transactionId}`,
      transactionId,
      token,
      checkoutUrl,
    };
  }

  /**
   * Vérifie la signature HMAC-SHA256 du webhook FedaPay.
   * Retourne true si FEDAPAY_WEBHOOK_SECRET n'est pas configuré (mode dev).
   */
  verifySignature(rawBody: string | Buffer, signature: string): boolean {
    const secret = this.config.get<string>('FEDAPAY_WEBHOOK_SECRET', '');
    if (!secret) return true;
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return signature === expected || signature === `sha256=${expected}`;
  }
}
