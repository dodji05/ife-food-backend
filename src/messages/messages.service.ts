import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  async sendMessage(senderId: string, conversationId: string, content: string) {
    // Sanitize: remove phone numbers from message content
    const sanitized = content.replace(/(\+?\d[\d\s\-()]{8,}\d)/g, '[numéro masqué]');
    return this.prisma.message.create({ data: { conversationId, senderId, content: sanitized } });
  }

  async getConversation(conversationId: string, userId: string) {
    return this.prisma.message.findMany({
      where: { conversationId },
      include: { sender: { select: { name: true, firstName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async markRead(conversationId: string) {
    return this.prisma.message.updateMany({ where: { conversationId, read: false }, data: { read: true } });
  }
}
