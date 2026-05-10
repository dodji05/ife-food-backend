import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConfigAppService {
  constructor(private prisma: PrismaService) {}

  async getLegalPage(type: string, lang: string) {
    return this.prisma.legalPage.findUnique({ where: { type_lang: { type, lang: lang as any } } });
  }

  async getAllLegalPages(type: string) {
    return this.prisma.legalPage.findMany({ where: { type } });
  }

  async getBanners(countryCode?: string) {
    return this.prisma.banner.findMany({
      where: {
        isActive: true,
        OR: [
          { countries: { isEmpty: true } },
          ...(countryCode ? [{ countries: { has: countryCode } }] : []),
        ],
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async getConfig(key: string) {
    return this.prisma.platformConfig.findUnique({ where: { key } });
  }
}
