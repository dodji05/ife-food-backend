import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DeliveriesService {
  constructor(private prisma: PrismaService) {}

  async getDeliveryStatus(orderId: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
      include: {
        driver: {
          include: { user: { select: { name: true, firstName: true, avatarUrl: true, phone: true } } },
        },
      },
    });
    if (!delivery) throw new NotFoundException('Delivery not found');
    return { data: delivery };
  }

  async getDriverPosition(orderId: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
      include: { driver: { select: { currentLat: true, currentLng: true } } },
    });
    if (!delivery) throw new NotFoundException();
    if (!delivery.driver) throw new NotFoundException('Driver not found');
    return { lat: delivery.driver.currentLat, lng: delivery.driver.currentLng };
  }

  // Historique des deliveries d'un driver (DELIVERED + CANCELLED).
  // Pas de pagination pour l'instant — on ajoutera ?page=&limit= quand on
  // dépassera ~100 missions par driver (négligeable en early stage).
  // Inclut order + professional pour afficher nom de l'établissement et
  // deliveryFee dans la card mobile.
  async getDriverHistory(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException('Driver profile not found');

    const deliveries = await this.prisma.delivery.findMany({
      where: {
        driverId: driver.id,
        // L'enum DeliveryStatus n'a pas de "CANCELLED" — on utilise FAILED
        // pour matérialiser les missions annulées/échouées.
        status: { in: ['DELIVERED', 'FAILED'] },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          include: {
            professional: { select: { businessName: true, category: true } },
          },
        },
      },
    });
    return { data: deliveries };
  }
}
