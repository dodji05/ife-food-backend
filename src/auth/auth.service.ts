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
  async sendOtp(phone: string, countryCode: string): Promise<{ sessionId: string; otp?: string }> {
    const channel = this.config.get('OTP_CHANNEL', 'SMS') as 'SMS' | 'WHATSAPP';
    const { sessionId, code } = await this.otpService.createOtpSession(phone, channel);

    const isProd = this.config.get('NODE_ENV') === 'production';
    return {
      sessionId,
      // En production le champ est absent — en dev/staging il est exposé pour les tests
      ...(!isProd && { otp: code }),
    };
  }

  /** Step 2: Verify OTP and login/register */
  async verifyOtp(phone: string, code: string, sessionId: string, role: string = 'CLIENT') {
    const session = await this.otpService.verifyOtp(phone, code, sessionId);
    if (!session) throw new UnauthorizedException('Invalid or expired OTP');

    let user = await this.prisma.user.findUnique({ where: { phone } });
    const isNew = !user;

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phone,
          phoneCountry: phone.substring(0, 4),
          role: role as any,
          status: 'PENDING',
        },
      });
    }

    // Recharger avec les relations pour que le mobile puisse router correctement
    const fullUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: { professional: true, driver: true },
    });

    const tokens = await this.generateTokens(user.id, user.role);
    return { user: fullUser, ...tokens, isNewUser: isNew || !user.name };
  }

  /** Set/Verify PIN */
  async setPin(userId: string, pin: string): Promise<void> {
    const hash = await bcrypt.hash(pin, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { pinHash: hash } });
  }

  async verifyPin(phone: string, pin: string) {
    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { professional: true, driver: true },
    });
    if (!user?.pinHash) throw new BadRequestException('PIN not set');
    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) throw new UnauthorizedException('Invalid PIN');
    const tokens = await this.generateTokens(user.id, user.role);
    return { user, ...tokens };
  }

  /** Refresh token — vérifie le refresh token et génère une nouvelle paire */
  async refreshToken(refreshTokenString: string) {
    try {
      const payload = this.jwtService.verify<{ sub: string; role: string }>(
        refreshTokenString,
        { secret: this.config.get('JWT_REFRESH_SECRET') },
      );
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) throw new NotFoundException('User not found');
      return this.generateTokens(user.id, user.role);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  /** Logout — côté serveur stateless, les tokens expirent naturellement */
  async logout(_userId: string) {
    return { message: 'Déconnexion réussie' };
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
