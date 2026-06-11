import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { randomInt } from 'crypto';
import axios from 'axios';
import { Twilio } from 'twilio';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  private async loadOtpCreds(): Promise<any> {
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'otpCredentials' } });
    return (cfg?.value as any) ?? {};
  }

  /** Generate and send OTP */
  async createOtpSession(phone: string, channel: 'SMS' | 'WHATSAPP'): Promise<{ sessionId: string; code: string }> {
    // Check for existing pending session (rate limit)
    const recent = await this.prisma.otpSession.findFirst({
      where: { phone, verified: false, createdAt: { gte: new Date(Date.now() - 60000) } },
    });
    if (recent) throw new BadRequestException('Please wait 60 seconds before requesting a new code');

    // Check block
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

    // Send OTP via channel
    await this.sendOtp(phone, code, channel);
    return { sessionId, code };
  }

  /** Verify OTP code */
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

  private async sendOtp(phone: string, code: string, channel: 'SMS' | 'WHATSAPP') {
    const message = `Your ifè FOOD verification code is: ${code}. Valid for 5 minutes.`;
    if (channel === 'SMS') await this.sendSms(phone, message);
    else await this.sendWhatsapp(phone, message);
  }

  private async sendSms(to: string, message: string) {
    try {
      const dbCreds = await this.loadOtpCreds();
      const accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID') || dbCreds.SMS?.accountSid;
      const authToken  = this.config.get<string>('TWILIO_AUTH_TOKEN')  || dbCreds.SMS?.authToken;
      const from       = this.config.get<string>('TWILIO_PHONE_NUMBER') || dbCreds.SMS?.phoneNumber;
      if (!accountSid || !authToken) throw new Error('Twilio not configured');
      const client = new Twilio(accountSid, authToken);
      await client.messages.create({ body: message, from, to });
    } catch (err) {
      this.logger.error('SMS send failed', err);
      throw new BadRequestException('Failed to send OTP via SMS');
    }
  }

  private async sendWhatsapp(to: string, message: string) {
    try {
      const dbCreds    = await this.loadOtpCreds();
      const apiUrl     = dbCreds.WHATSAPP?.apiUrl     || this.config.get('WHATSAPP_API_URL');
      const phoneId    = dbCreds.WHATSAPP?.phoneId    || this.config.get('WHATSAPP_PHONE_ID');
      const token      = dbCreds.WHATSAPP?.accessToken|| this.config.get('WHATSAPP_ACCESS_TOKEN');
      await axios.post(
        `${apiUrl}/${phoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } },
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (err) {
      this.logger.error('WhatsApp send failed', err);
      throw new BadRequestException('Failed to send OTP via WhatsApp');
    }
  }
}
