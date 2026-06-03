import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';
import { JWT } from 'google-auth-library';

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  private cachedToken: string | null = null;
  private cachedTokenExpiry = 0;
  private jwtClient: JWT | null = null;

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  /** Vérifie la connexion Firebase au démarrage et log le résultat. */
  async onModuleInit() {
    try {
      const raw = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON');
      if (!raw || raw.includes('your_firebase')) {
        this.logger.warn('FCM ⚠️  FIREBASE_SERVICE_ACCOUNT_JSON non configuré — push désactivé');
        return;
      }
      const token = await this.getFirebaseToken();
      if (token) {
        this.logger.log('FCM ✅ Connexion Firebase établie — push activé');
      } else {
        this.logger.error('FCM ❌ Token Firebase vide — vérifier FIREBASE_SERVICE_ACCOUNT_JSON');
      }
    } catch (e: any) {
      this.logger.error('FCM ❌ Échec connexion Firebase', e?.message ?? e);
    }
  }

  async sendPush(userId: string, title: string, body: string, data?: any, channelId = 'ife_orders') {
    // 1. Persistance DB systématique — la notification interne (badge + liste
    // in-app) DOIT toujours être créée, indépendamment du push FCM réseau.
    // (Bug corrigé : un return anticipé sur fcmToken absent sautait la création.)
    await this.prisma.notification.create({
      data: { userId, type: 'SYSTEM', title, body, data },
    }).catch((e) => this.logger.error('DB notification create failed', e?.message ?? e));

    // 2. Push FCM — best-effort. Si l'utilisateur n'a pas de token, on s'arrête là.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.fcmToken) {
      this.logger.warn(`FCM push skipped — userId=${userId} : fcmToken absent (notif interne créée quand même)`);
      return;
    }

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
              android: { priority: 'HIGH', notification: { channel_id: channelId } },
              apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
            },
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        this.logger.log(`FCM push ✅ envoyé à userId=${userId} : "${title}"`);
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
  }

  async sendOrderNotification(orderId: string, status: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { client: true, professional: { include: { user: true } }, driver: { include: { user: true } } },
    });
    if (!order) return;

    const statusMessages: Record<string, { title: string; body: string; recipients: string[] }> = {
      PAID:             { title: 'Nouvelle commande !', body: `Un client a passé une commande de ${order.totalAmount.toLocaleString('fr-FR')} ${order.currency} — chez ${order.professional.businessName}`, recipients: [order.professional.userId] },
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

    // Notification dédiée au pro à la livraison (message adapté, distinct du
    // "Bonne dégustation" client) pour qu'il puisse clôturer son suivi.
    if (status === 'DELIVERED') {
      await this.sendPush(
        order.professional.userId,
        'Commande livrée',
        `La commande #${order.id.slice(-6).toUpperCase()} a été livrée au client.`,
        { orderId, status },
      );
    }
  }

  /** Push FCM ciblé sur un driver pour une nouvelle mission. */
  async sendDriverMissionPush(driverUserId: string, mission: {
    orderId: string;
    professionalName: string;
    professionalAddress: string;
    deliveryZone: string;
    distanceToPickupKm: number | null;
    distanceKm: number;
    deliveryFee: number;
    currency: string;
  }) {
    const pickupPart = mission.distanceToPickupKm != null
      ? `À ${mission.distanceToPickupKm.toFixed(1)} km`
      : mission.professionalAddress;
    const zone = mission.deliveryZone || 'Livraison';
    const title = `🛵 Nouvelle mission — ${mission.professionalName}`;
    const body  = `${pickupPart} · ${zone} · ${mission.distanceKm.toFixed(1)} km · ${mission.deliveryFee.toFixed(0)} ${mission.currency}`;
    await this.sendPush(driverUserId, title, body, {
      orderId:              mission.orderId,
      type:                 'NEW_MISSION',
      professionalName:     mission.professionalName,
      deliveryFee:          String(mission.deliveryFee),
      distanceKm:           String(mission.distanceKm),
      distanceToPickupKm:   mission.distanceToPickupKm != null ? String(mission.distanceToPickupKm) : '',
      deliveryZone:         mission.deliveryZone,
    }, 'ife_missions_v2'); // canal MAX → popup heads-up prioritaire livreur
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
