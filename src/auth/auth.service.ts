import { Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import * as OTPAuth from 'otpauth';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from './otp.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private otpService: OtpService,
  ) {}

  /** Step 1: Send OTP */
  async sendOtp(phone: string, countryCode: string): Promise<{ sessionId: string }> {
    const channel = this.config.get('OTP_CHANNEL', 'SMS') as 'SMS' | 'WHATSAPP';
    const { sessionId } = await this.otpService.createOtpSession(phone, channel);
    return { sessionId };
  }

  /** Step 2: Verify OTP and login/register */
  async verifyOtp(phone: string, code: string, sessionId: string, role: string = 'CLIENT') {
    const session = await this.otpService.verifyOtp(phone, code, sessionId);
    if (!session) throw new UnauthorizedException('Invalid or expired OTP');

    let user = await this.prisma.user.findUnique({ where: { phone } });

    if (!user) {
      // New user — CLIENT actif immédiatement, PRO/DRIVER en attente de validation
      user = await this.prisma.user.create({
        data: {
          phone,
          phoneCountry: phone.substring(0, 4),
          role: role as any,
          status: role === 'CLIENT' ? 'ACTIVE' : 'PENDING',
        },
      });
    }

    // Récupère les relations professional/driver pour le routage côté app
    const fullUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: {
        professional: { select: { id: true, businessName: true, logoUrl: true, category: true, status: true, isOpen: true } },
        driver:       { select: { id: true, status: true, isAvailable: true, vehicleType: true } },
      },
    });

    const tokens = await this.generateTokens(user.id, user.role);
    return { user: fullUser, ...tokens, isNewUser: !user.pinHash };
  }

  async checkPhoneExists(phone: string): Promise<{ exists: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    return { exists: !!user };
  }

  /** Set/Verify PIN */
  async setPin(userId: string, pin: string): Promise<void> {
    const hash = await bcrypt.hash(pin, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { pinHash: hash } });
  }

  async verifyPin(phone: string, pin: string) {
    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: {
        professional: { select: { id: true, businessName: true, logoUrl: true, category: true, status: true, isOpen: true } },
        driver:       { select: { id: true, status: true, isAvailable: true, vehicleType: true } },
      },
    });
    if (!user?.pinHash) throw new BadRequestException('PIN not set');
    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) throw new UnauthorizedException('Invalid PIN');
    const tokens = await this.generateTokens(user.id, user.role);
    return { user, ...tokens };
  }

  /** Refresh token */
  async refreshToken(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const tokens = await this.generateTokens(user.id, user.role);
    return { ...tokens };
  }

  /** Admin 2FA */
  async verify2fa(userId: string, totpCode: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.twoFaSecret) throw new BadRequestException('2FA not set up');
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.twoFaSecret) });
    const delta = totp.validate({ token: totpCode, window: 1 });
    if (delta === null) throw new UnauthorizedException('Code 2FA invalide');
    return this.generateTokens(user.id, user.role);
  }

  private async generateTokens(userId: string, role: string) {
    const payload = { sub: userId, role };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN', '30d'),
    });
    return { accessToken, refreshToken };
  }
}
