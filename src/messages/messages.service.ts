import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async sendMessage(senderId: string, conversationId: string, content: string) {
    const sanitized = content.replace(/(\+?\d[\d\s\-()]{8,}\d)/g, '[numéro masqué]');
    const message = await this.prisma.message.create({
      data: { conversationId, senderId, content: sanitized },
    });

    // Notification push au(x) destinataire(s) — même app fermée. Best-effort.
    this.notifyRecipients(senderId, conversationId, sanitized).catch((e) =>
      this.logger.error('Message push failed', e?.message ?? e),
    );

    return message;
  }

  /** Envoie un push aux participants de la conversation autres que l'expéditeur. */
  private async notifyRecipients(senderId: string, conversationId: string, content: string) {
    const orderId = conversationId.replace(/^order_/, '');
    if (!orderId) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        clientId: true,
        driver:       { select: { userId: true } },
        professional: { select: { userId: true } },
      },
    });
    if (!order) return;

    // Participants = client + livreur + pro ; on retire l'expéditeur et les nuls.
    const recipients = [order.clientId, order.driver?.userId, order.professional?.userId]
      .filter((uid): uid is string => !!uid && uid !== senderId);
    if (recipients.length === 0) return;

    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { name: true, firstName: true },
    });
    const senderName = [sender?.firstName, sender?.name].filter(Boolean).join(' ') || 'Nouveau message';
    const preview = content.length > 80 ? `${content.slice(0, 77)}…` : content;

    await Promise.all(recipients.map((uid) =>
      this.notifications.sendPush(uid, senderName, preview, {
        type: 'NEW_MESSAGE',
        conversationId,
        orderId,
      }, 'ife_messages_chat'),
    ));
  }

  async getConversation(conversationId: string, _userId: string) {
    return this.prisma.message.findMany({
      where: { conversationId },
      include: { sender: { select: { name: true, firstName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async markRead(conversationId: string, readerId: string) {
    return this.prisma.message.updateMany({
      where: { conversationId, read: false, senderId: { not: readerId } },
      data: { read: true },
    });
  }

  /** Returns true if userId may access the conversation (is client, driver, or professional of the order). */
  async canAccessConversation(userId: string, orderId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { driver: { select: { id: true } }, professional: { select: { id: true } } },
    });
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { clientId: true, driverId: true, professionalId: true },
    });
    if (!order) return false;
    return (
      order.clientId === userId ||
      (user?.driver != null && order.driverId === user.driver.id) ||
      (user?.professional != null && order.professionalId === user.professional.id)
    );
  }

  /** List conversations for a user — ordered by most recent message. */
  async getConversations(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { driver: { select: { id: true } }, professional: { select: { id: true } } },
    });

    const orders = await this.prisma.order.findMany({
      where: {
        OR: [
          { clientId: userId },
          ...(user?.driver ? [{ driverId: user.driver.id }] : []),
          ...(user?.professional ? [{ professionalId: user.professional.id }] : []),
        ],
      },
      select: {
        id: true,
        status: true,
        clientId: true,
        client:       { select: { id: true, name: true, firstName: true, avatarUrl: true } },
        driver:       { select: { id: true, user: { select: { id: true, name: true, firstName: true, avatarUrl: true } } } },
        professional: { select: { id: true, businessName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const results = await Promise.all(orders.map(async (order) => {
      const convId = `order_${order.id}`;
      const [lastMsg, unreadCount] = await Promise.all([
        this.prisma.message.findFirst({
          where: { conversationId: convId },
          orderBy: { createdAt: 'desc' },
          include: { sender: { select: { name: true, firstName: true } } },
        }),
        this.prisma.message.count({
          where: { conversationId: convId, read: false, senderId: { not: userId } },
        }),
      ]);
      if (!lastMsg) return null;

      // Determine display name of the "other" party
      let otherName = '';
      let otherAvatar: string | null = null;
      if (order.clientId === userId) {
        const du = order.driver?.user;
        otherName = du ? [du.firstName, du.name].filter(Boolean).join(' ') : order.professional.businessName;
        otherAvatar = du?.avatarUrl ?? null;
      } else {
        otherName = [order.client.firstName, order.client.name].filter(Boolean).join(' ');
        otherAvatar = order.client.avatarUrl ?? null;
      }

      return {
        conversationId: convId,
        orderId: order.id,
        orderStatus: order.status,
        otherName: otherName.trim() || 'Inconnu',
        otherAvatar,
        lastMessage: {
          content: lastMsg.content,
          createdAt: lastMsg.createdAt,
          senderName: [lastMsg.sender.firstName, lastMsg.sender.name].filter(Boolean).join(' '),
        },
        unreadCount,
      };
    }));

    return results
      .filter(Boolean)
      .sort((a, b) => new Date(b!.lastMessage.createdAt).getTime() - new Date(a!.lastMessage.createdAt).getTime());
  }

  /** Admin — all conversations with last message (no access restriction). */
  async getAllConversations(search?: string) {
    const where = search
      ? { conversationId: { contains: search, mode: 'insensitive' as const } }
      : {};

    const lastMessages = await this.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      distinct: ['conversationId'],
      include: { sender: { select: { name: true, firstName: true } } },
      take: 100,
    });

    return Promise.all(lastMessages.map(async (msg) => {
      const count = await this.prisma.message.count({ where: { conversationId: msg.conversationId } });
      return {
        conversationId: msg.conversationId,
        lastMessage: { content: msg.content, createdAt: msg.createdAt },
        senderName: [msg.sender.firstName, msg.sender.name].filter(Boolean).join(' ') || 'Inconnu',
        messageCount: count,
      };
    }));
  }
}
