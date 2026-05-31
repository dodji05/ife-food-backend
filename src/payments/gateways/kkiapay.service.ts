import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class KkiapayService {
  private readonly logger = new Logger(KkiapayService.name);
  // KKiaPay n'a PAS d'API d'initiation serveur-à-serveur : le paiement passe
  // obligatoirement par le widget côté mobile (clé publique). Le serveur ne
  // fait que VÉRIFIER la transaction après coup via /api/v1/transactions/status.
  // ⚠️ L'URL dépend du mode : une transaction sandbox DOIT être vérifiée sur
  // api-sandbox.kkiapay.me, sinon "Invalid API KEY".
  private readonly liveUrl    = 'https://api.kkiapay.me/api/v1';
  private readonly sandboxUrl = 'https://api-sandbox.kkiapay.me/api/v1';

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
    overrideConfig?: { publicKey?: string; privateKey?: string; secret?: string; sandbox?: boolean },
  ): Promise<{ status: string; amount?: number }> {
    const publicKey  = overrideConfig?.publicKey  || this.config.get('KKIAPAY_PUBLIC_KEY', '');
    const privateKey = overrideConfig?.privateKey || this.config.get('KKIAPAY_PRIVATE_KEY', '');
    const secretKey  = overrideConfig?.secret      || this.config.get('KKIAPAY_SECRET', '');
    const sandbox    = overrideConfig?.sandbox !== undefined
      ? overrideConfig.sandbox
      : this.config.get('KKIAPAY_SANDBOX', 'true') === 'true';

    if (!privateKey || privateKey.includes('your_') || privateKey.length < 10) {
      throw new BadRequestException('KKiaPay non configuré — renseignez les clés KKiaPay');
    }

    const baseUrl = sandbox ? this.sandboxUrl : this.liveUrl;

    try {
      // Le SDK serveur officiel KKiaPay envoie les TROIS clés ensemble :
      //   x-api-key = clé publique · x-private-key = clé privée · x-secret-key = secret
      const { data } = await axios.post(
        `${baseUrl}/transactions/status`,
        { transactionId },
        { headers: {
          'x-api-key':     publicKey,
          'x-private-key': privateKey,
          'x-secret-key':  secretKey,
        } },
      );
      // Log de diagnostic : réponse brute KKiaPay pour comprendre le format.
      this.logger.log(`KKiaPay verify txId=${transactionId} → ${JSON.stringify(data)}`);
      // Le statut peut arriver en majuscules ou minuscules selon l'API.
      const rawStatus = String(data?.status ?? data?.state ?? 'PENDING').toUpperCase();
      return { status: rawStatus, amount: data?.amount };
    } catch (e: any) {
      this.logger.error(`KKiaPay verify échec txId=${transactionId} : ${JSON.stringify(e?.response?.data) ?? e?.message}`);
      const msg = e?.response?.data?.message
        ?? JSON.stringify(e?.response?.data)
        ?? e?.message
        ?? 'Erreur KKiaPay';
      throw new BadRequestException(`KKiaPay: ${msg}`);
    }
  }
}
