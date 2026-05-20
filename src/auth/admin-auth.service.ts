import {
  Injectable, UnauthorizedException, BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Response, CookieOptions } from 'express';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from './otp.service';
import { AdminLoginDto, AdminRequestResetDto, AdminConfirmResetDto } from './dto/admin-auth.dto';

const COOKIE_BASE: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
};

@Injectable()
export class AdminAuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private otpService: OtpService,
  ) {}

  async login(dto: AdminLoginDto, res: Response) {
    // Message générique identique pour email inconnu ET mauvais password (anti-énumération)
    const invalidError = new UnauthorizedException('Identifiants invalides');

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { admin: true },
    });
    if (!user || user.role !== 'ADMIN') throw invalidError;
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Compte désactivé');
    if (!user.pinHash) throw invalidError;

    const passwordValid = await bcrypt.compare(dto.password, user.pinHash);
    if (!passwordValid) throw invalidError;

    this.setTokenCookies(res, user.id, user.role);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      role: user.role,
      admin: user.admin ? { level: user.admin.level } : null,
    };
  }

  async refreshFromCookie(refreshToken: string, res: Response) {
    let payload: { sub: string; role: string };
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalide ou expiré');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException();

    this.setTokenCookies(res, user.id, user.role);
    return { ok: true };
  }

  logout(res: Response) {
    res.clearCookie('accessToken', { ...COOKIE_BASE });
    res.clearCookie('refreshToken', { ...COOKIE_BASE, path: '/api/v1/auth/admin/refresh' });
    return { ok: true };
  }

  async requestReset(dto: AdminRequestResetDto) {
    // Réponse identique que l'email existe ou non (anti-énumération)
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (user && user.role === 'ADMIN' && user.status === 'ACTIVE' && user.phone) {
      const channel = this.config.get<'SMS' | 'WHATSAPP'>('OTP_CHANNEL', 'SMS');
      const { sessionId } = await this.otpService.createOtpSession(user.phone, channel);
      return { ok: true, sessionId };
    }
    return { ok: true, sessionId: 'not-applicable' };
  }

  async confirmReset(dto: AdminConfirmResetDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || user.role !== 'ADMIN' || !user.phone) {
      throw new BadRequestException('Réinitialisation impossible');
    }

    await this.otpService.verifyOtp(user.phone, dto.code, dto.sessionId);

    if (dto.newPassword.length < 8) {
      throw new BadRequestException('Le mot de passe doit contenir au moins 8 caractères');
    }

    const hash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: user.id }, data: { pinHash: hash } });
    return { ok: true };
  }

  getMe(user: any) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      role: user.role,
      admin: user.admin ? { level: user.admin.level } : null,
    };
  }

  private setTokenCookies(res: Response, userId: string, role: string) {
    const payload = { sub: userId, role };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.config.get('JWT_SECRET'),
      expiresIn: '15m',
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: '7d',
    });

    res.cookie('accessToken', accessToken, {
      ...COOKIE_BASE,
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refreshToken', refreshToken, {
      ...COOKIE_BASE,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth/admin/refresh',
    });
  }
}
