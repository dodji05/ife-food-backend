import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserAddressDto, UpdateUserAddressDto } from './dto/user-address.dto';

@Injectable()
export class UserAddressesService {
  constructor(private prisma: PrismaService) {}

  /// Liste toutes les adresses du user, default en premier puis par createdAt desc.
  async list(userId: string) {
    return this.prisma.userAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /// Crée une adresse. Si isDefault=true, désactive les autres dans la même
  /// transaction pour garantir une seule adresse par défaut par user.
  /// Si c'est la 1ère adresse du user, force isDefault=true (UX : éviter
  /// que le user oublie de cocher et n'ait aucune adresse par défaut).
  async create(userId: string, dto: CreateUserAddressDto) {
    const count = await this.prisma.userAddress.count({ where: { userId } });
    const shouldBeDefault = dto.isDefault === true || count === 0;

    return this.prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.userAddress.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.userAddress.create({
        data: {
          userId,
          label: dto.label,
          address: dto.address,
          city: dto.city,
          country: dto.country ?? 'BJ',
          lat: dto.lat,
          lng: dto.lng,
          instructions: dto.instructions,
          isDefault: shouldBeDefault,
        },
      });
    });
  }

  async update(userId: string, id: string, dto: UpdateUserAddressDto) {
    const addr = await this.prisma.userAddress.findUnique({ where: { id } });
    if (!addr) throw new NotFoundException('Adresse introuvable');
    if (addr.userId !== userId) throw new ForbiddenException();

    // Si on bascule à isDefault=true, désactiver les autres dans une transaction.
    if (dto.isDefault === true && !addr.isDefault) {
      return this.prisma.$transaction(async (tx) => {
        await tx.userAddress.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
        return tx.userAddress.update({ where: { id }, data: dto });
      });
    }
    return this.prisma.userAddress.update({ where: { id }, data: dto });
  }

  /// Supprime. Si c'était l'adresse par défaut, promote la plus récente
  /// restante en default (UX : toujours avoir une default si ≥1 adresse).
  async remove(userId: string, id: string) {
    const addr = await this.prisma.userAddress.findUnique({ where: { id } });
    if (!addr) throw new NotFoundException('Adresse introuvable');
    if (addr.userId !== userId) throw new ForbiddenException();

    await this.prisma.$transaction(async (tx) => {
      await tx.userAddress.delete({ where: { id } });
      if (addr.isDefault) {
        const next = await tx.userAddress.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
        });
        if (next) {
          await tx.userAddress.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
        }
      }
    });
    return { ok: true };
  }

  /// Endpoint dédié pour marquer une adresse comme défaut (alternative au
  /// PATCH générique avec isDefault:true — plus explicite côté UI).
  async setDefault(userId: string, id: string) {
    const addr = await this.prisma.userAddress.findUnique({ where: { id } });
    if (!addr) throw new NotFoundException('Adresse introuvable');
    if (addr.userId !== userId) throw new ForbiddenException();
    if (addr.isDefault) return addr; // déjà default, no-op

    return this.prisma.$transaction(async (tx) => {
      await tx.userAddress.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.userAddress.update({ where: { id }, data: { isDefault: true } });
    });
  }
}
