import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  async sendPush(userId: string, title: string, body: string, data?: any) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.fcmToken) return;

    try {
      const projectId = this.config.get('FIREBASE_PROJECT_ID');
      await axios.post(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          message: {
            token: user.fcmToken,
            notification: { title, body },
            data: data ? Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])) : {},
          },
        },
        { headers: { Authorization: `Bearer ${await this.getFirebaseToken()}` } }
      );
    } catch (err: unknown) {
      this.logger.error('FCM push failed', err instanceof Error ? err.message : String(err));
    }

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

  private async getFirebaseToken(): Promise<string> {
    // In production, use google-auth-library to get OAuth2 token
    // For now return env token for simplicity
    return this.config.get('FIREBASE_ACCESS_TOKEN', '');
  }
}
