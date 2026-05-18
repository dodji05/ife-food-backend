import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';
import { JWT } from 'google-auth-library';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  // ── Cache OAuth token Firebase ────────────────────────────────────────────
  // Les access tokens FCM expirent en 1h (3600s). On cache et refresh à 55min
  // pour éviter tout edge case. Le bug initial : la version précédente lisait
  // FIREBASE_ACCESS_TOKEN du .env -> jamais rafraîchi -> toutes les notifs
  // échouaient silencieusement après 1h.
  private cachedToken: string | null = null;
  private cachedTokenExpiry = 0;
  private jwtClient: JWT | null = null;

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  async sendPush(userId: string, title: string, body: string, data?: any) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.fcmToken) return;

    try {
      const projectId = this.config.get('FIREBASE_PROJECT_ID');
      const token = await this.getFirebaseToken();
      if (!token) {
        this.logger.warn('FCM token unavailable — skipping push (check FIREBASE_SERVICE_ACCOUNT_JSON env)');
      } else {
        await axios.post(
          `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
          {
            message: {
              token: user.fcmToken,
              notification: { title, body },
              data: data ? Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])) : {},
              // Hint Android : channel à créer côté mobile (cf. FcmService).
              android: { priority: 'HIGH', notification: { channel_id: 'ife_orders' } },
              apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
            },
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      }
    } catch (err: unknown) {
      // Token invalide (401) ? On invalide le cache pour forcer un refresh
      // au prochain appel (cas où la clé service account a été révoquée).
      const status = (err as any)?.response?.status;
      if (status === 401 || status === 403) {
        this.cachedToken = null;
        this.cachedTokenExpiry = 0;
      }
      this.logger.error('FCM push failed', err instanceof Error ? err.message : String(err));
    }

    // Persistance DB systématique — même si le push réseau échoue, l'utilisateur
    // verra la notif au prochain GET /notifications (et badge in-app).
    await this.prisma.notification.create({
      data: { userId, type: 'SYSTEM', title, body, data },
    });
  }

  async sendOrderNotification(orderId: string, status: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { client: true, professional: { include: { user: true } }, driver: { include: { user: true } } },
    });
    if (!order) return;

    const statusMessages: Record<string, { title: string; body: string; recipients: string[] }> = {
      PAID:             { title: 'Nouvelle commande !', body: 'Vous avez une nouvelle commande.', recipients: [order.professional.userId] },
      ACCEPTED:         { title: 'Commande acceptée', body: 'Votre commande a été acceptée.', recipients: [order.clientId] },
      IN_PREPARATION:   { title: 'En préparation', body: 'Votre commande est en cours de préparation.', recipients: [order.clientId] },
      DRIVER_ASSIGNED:  { title: 'Livreur assigné', body: 'Un livreur a été assigné à votre commande.', recipients: [order.clientId, order.professional.userId] },
      IN_DELIVERY:      { title: 'En livraison', body: 'Votre commande est en route !', recipients: [order.clientId] },
      DELIVERED:        { title: 'Livré !', body: 'Votre commande a été livrée. Bonne dégustation !', recipients: [order.clientId] },
      CANCELLED:        { title: 'Commande annulée', body: 'Votre commande a été annulée.', recipients: [order.clientId, order.professional.userId] },
    };

    const msg = statusMessages[status];
    if (!msg) return;

    await Promise.all(msg.recipients.map((uid) => this.sendPush(uid, msg.title, msg.body, { orderId, status })));
  }

  async sendToAllUsers(title: string, body: string, role?: string, countries?: string[]) {
    const where: any = {};
    if (role) where.role = role;
    if (countries?.length) where.countryCode = { in: countries };
    const users = await this.prisma.user.findMany({ where, select: { id: true } });
    await Promise.all(users.map((u) => this.sendPush(u.id, title, body)));
    return { sent: users.length };
  }

  async getUserNotifications(userId: string) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async markAsRead(userId: string, notificationId: string) {
    return this.prisma.notification.updateMany({ where: { id: notificationId, userId }, data: { read: true } });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
  }

  /**
   * Génère un access token OAuth2 valide pour l'API FCM HTTP V1.
   *
   * Stratégie :
   *   - Lit la clé Service Account depuis FIREBASE_SERVICE_ACCOUNT_JSON (string
   *     JSON intégral) — éviter de stocker un fichier sur disque.
   *   - Cache le token 55min (les tokens FCM expirent en 1h).
   *   - Le JWT client est instancié une seule fois (constructor lazy).
   *
   * Fallback historique : si la variable d'env n'est pas définie, on retombe
   * sur FIREBASE_ACCESS_TOKEN (le legacy token statique) — utile en dev local
   * pour ne pas casser, mais à éviter en prod.
   */
  private async getFirebaseToken(): Promise<string> {
    // Token encore valide → on le réutilise.
    if (this.cachedToken && Date.now() < this.cachedTokenExpiry) {
      return this.cachedToken;
    }

    // Init paresseuse du client JWT à partir du Service Account JSON.
    if (!this.jwtClient) {
      const raw = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON');
      if (!raw) {
        // Fallback rétro-compat — utilisable en dev/test.
        return this.config.get('FIREBASE_ACCESS_TOKEN', '');
      }
      let creds: { client_email: string; private_key: string };
      try {
        creds = JSON.parse(raw);
      } catch (e) {
        this.logger.error('FIREBASE_SERVICE_ACCOUNT_JSON malformé', e as any);
        return '';
      }
      this.jwtClient = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      });
    }

    try {
      const { access_token } = await this.jwtClient.authorize();
      if (!access_token) return '';
      this.cachedToken = access_token;
      // Refresh 5min avant l'expiration réelle (1h → cache 55min).
      this.cachedTokenExpiry = Date.now() + 55 * 60 * 1000;
      return access_token;
    } catch (err: unknown) {
      this.logger.error('Firebase OAuth token fetch failed', err instanceof Error ? err.message : String(err));
      return '';
    }
  }
}
