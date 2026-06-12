import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { randomInt } from 'crypto';

@Injectable()
export class OtpService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  /** Crée une session OTP — le code est retourné directement dans la réponse (bypass, aucun SMS envoyé) */
  async createOtpSession(phone: string, channel: 'SMS' | 'WHATSAPP'): Promise<{ sessionId: string; code: string }> {
    const recent = await this.prisma.otpSession.findFirst({
      where: { phone, verified: false, createdAt: { gte: new Date(Date.now() - 60000) } },
    });
    if (recent) throw new BadRequestException('Please wait 60 seconds before requesting a new code');

    const blocked = await this.prisma.otpSession.findFirst({
      where: { phone, verified: false, attempts: { gte: 3 }, createdAt: { gte: new Date(Date.now() - 15 * 60000) } },
    });
    if (blocked) throw new BadRequestException('Account temporarily blocked. Try again in 15 minutes');

    const code = randomInt(100000, 1000000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const sessionId = uuidv4();
    const expiryMinutes = this.config.get<number>('OTP_EXPIRY_MINUTES', 5);

    await this.prisma.otpSession.create({
      data: {
        id: sessionId,
        phone,
        code: codeHash,
        channel: channel as any,
        expiresAt: new Date(Date.now() + expiryMinutes * 60000),
      },
    });

    return { sessionId, code };
  }

  /** Vérifie un code OTP */
  async verifyOtp(phone: string, code: string, sessionId: string) {
    const session = await this.prisma.otpSession.findFirst({
      where: { id: sessionId, phone, verified: false, expiresAt: { gte: new Date() } },
    });
    if (!session) throw new BadRequestException('OTP expired or not found');
    if (session.attempts >= 3) throw new BadRequestException('Too many attempts. Request a new code');

    const valid = await bcrypt.compare(code, session.code);
    if (!valid) {
      await this.prisma.otpSession.update({ where: { id: sessionId }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException(`Invalid code. ${3 - session.attempts - 1} attempts remaining`);
    }

    await this.prisma.otpSession.update({ where: { id: sessionId }, data: { verified: true } });
    return session;
  }
}
