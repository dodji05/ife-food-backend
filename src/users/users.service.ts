import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto, UpdateLangDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.email) {
      const existing = await this.prisma.user.findFirst({ where: { email: dto.email, id: { not: userId } } });
      if (existing) throw new ConflictException('Email already in use');
    }
    // Cast 'as any' nécessaire : le DTO type 'lang' comme string générique
    // mais Prisma le typed enum Language. La valeur est déjà validée par
    // @IsIn(['fr','en',...]) sur le DTO -> safe à passer tel quel.
    return this.prisma.user.update({
      where: { id: userId },
      data: dto as any,
    });
  }

  async updateLanguage(userId: string, dto: UpdateLangDto) {
    return this.prisma.user.update({ where: { id: userId }, data: { lang: dto.lang as any } });
  }

  async updateCountry(userId: string, countryCode: string, currency: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { countryCode, currency } });
  }

  async updateFcmToken(userId: string, fcmToken: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { fcmToken } });
  }

  async updateAvatar(userId: string, avatarUrl: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
  }

  async deleteAccount(userId: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date(), status: 'BANNED', phone: `deleted_${Date.now()}` } });
  }

  async acceptLegal(userId: string, documentType: string, version: string, ip: string) {
    return this.prisma.legalAcceptance.create({ data: { userId, documentType, version, ip } });
  }

  async getLegalAcceptances(userId: string) {
    return this.prisma.legalAcceptance.findMany({ where: { userId } });
  }

  async getOrCreateReferralCode(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true, name: true, firstName: true },
    });
    if (!user) throw new Error('User not found');
    if ((user as any).referralCode) {
      return { data: { referralCode: (user as any).referralCode } };
    }
    // Generate unique 8-char alphanumeric code.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    let attempts = 0;
    do {
      code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      attempts++;
    } while (
      attempts < 10 &&
      await this.prisma.user.findFirst({ where: { referralCode: code } as any })
    );
    await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } as any });
    return { data: { referralCode: code } };
  }
}
