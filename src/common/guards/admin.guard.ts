import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest();
    if (!user?.id) throw new ForbiddenException('Accès refusé');

    const adminRecord = await this.prisma.admin.findUnique({ where: { userId: user.id } });
    if (!adminRecord) throw new ForbiddenException('Compte administrateur introuvable');

    return true;
  }
}
