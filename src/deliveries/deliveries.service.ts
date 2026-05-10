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
}
