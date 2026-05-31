import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class KkiapayService {
  // KKiaPay n'a PAS d'API d'initiation serveur-à-serveur : le paiement passe
  // obligatoirement par le widget côté mobile (clé publique). Le serveur ne
  // fait que VÉRIFIER la transaction après coup via /api/v1/transactions/status
  // avec la clé privée + secret.
  private baseUrl = 'https://api.kkiapay.me/api/v1';

  constructor(private config: ConfigService) {}

  /**
   * Renvoie la config publique nécessaire au widget mobile (clé publique +
   * mode sandbox). La clé privée/secret reste côté serveur.
   */
  getPublicConfig(overrideConfig?: { publicKey?: string; sandbox?: boolean }) {
    const sandbox = overrideConfig?.sandbox !== undefined
      ? overrideConfig.sandbox
      : this.config.get('KKIAPAY_SANDBOX', 'true') === 'true';
    const publicKey = overrideConfig?.publicKey || this.config.get('KKIAPAY_PUBLIC_KEY', '');
    return { publicKey, sandbox };
  }

  /**
   * Vérifie le statut d'une transaction KKiaPay via son transactionId
   * (retourné par le widget côté mobile). Retourne le statut brut :
   * SUCCESS | FAILED | PENDING.
   */
  async verifyTransaction(
    transactionId: string,
    overrideConfig?: { privateKey?: string; secret?: string },
  ): Promise<{ status: string; amount?: number }> {
    const privateKey = overrideConfig?.privateKey || this.config.get('KKIAPAY_PRIVATE_KEY', '');

    if (!privateKey || privateKey.includes('your_') || privateKey.length < 10) {
      throw new BadRequestException('KKiaPay non configuré — renseignez KKIAPAY_PRIVATE_KEY');
    }

    try {
      // Vérification serveur KKiaPay : header x-api-key = clé privée.
      // (x-private-key/x-secret-key sont réservés au widget, pas à l'API serveur.)
      const { data } = await axios.post(
        `${this.baseUrl}/transactions/status`,
        { transactionId },
        { headers: { 'x-api-key': privateKey } },
      );
      // KKiaPay renvoie status: SUCCESS | FAILED | PENDING (+ amount).
      return { status: (data?.status ?? 'PENDING') as string, amount: data?.amount };
    } catch (e: any) {
      const msg = e?.response?.data?.message
        ?? JSON.stringify(e?.response?.data)
        ?? e?.message
        ?? 'Erreur KKiaPay';
      throw new BadRequestException(`KKiaPay: ${msg}`);
    }
  }
}
