import { Injectable, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateDriverDto, UpdateDriverDto, UpdateLocationDto } from './dto/driver.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class DriversService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async register(userId: string, dto: CreateDriverDto) {
    return this.prisma.driver.create({ data: { ...dto, userId, vehicleType: dto.vehicleType as any, status: 'PENDING' } });
  }

  async getMyProfile(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId }, include: { documents: true } });
    if (!driver) throw new NotFoundException('Driver profile not found');
    return { data: driver };
  }

  async updateProfile(userId: string, dto: UpdateDriverDto) {
    return this.prisma.driver.update({ where: { userId }, data: dto as any });
  }

  async toggleAvailability(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();
    const newStatus = driver.isAvailable ? 'OFFLINE' : 'ONLINE';
    return this.prisma.driver.update({ where: { userId }, data: { isAvailable: !driver.isAvailable, status: newStatus as any } });
  }

  async updateLocation(userId: string, dto: UpdateLocationDto) {
    return this.prisma.driver.update({ where: { userId }, data: { currentLat: dto.lat, currentLng: dto.lng } });
  }

  async getAvailableDrivers(lat: number, lng: number, radiusKm: number = 5) {
    const drivers = await this.prisma.driver.findMany({
      where: { isAvailable: true, status: 'ONLINE' },
      include: { user: { select: { name: true, firstName: true, avatarUrl: true, fcmToken: true } } },
    });

    const toRad = (d: number) => d * Math.PI / 180;
    const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
      const dLat = toRad(lat2 - lat1); const dLon = toRad(lng2 - lng1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    return drivers
      .filter((d) => d.currentLat && d.currentLng && haversine(lat, lng, d.currentLat, d.currentLng) <= radiusKm)
      .sort((a, b) => haversine(lat, lng, a.currentLat!, a.currentLng!) - haversine(lat, lng, b.currentLat!, b.currentLng!));
  }

  async acceptMission(userId: string, orderId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    // Check for existing delivery to avoid unique constraint violation on orderId
    const existing = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (existing) throw new ConflictException('A delivery already exists for this order');

    await this.prisma.order.update({ where: { id: orderId }, data: { driverId: driver.id, status: 'DRIVER_ASSIGNED' as any } });
    await this.prisma.delivery.create({ data: { orderId, driverId: driver.id } });
    await this.notifications.sendOrderNotification(orderId, 'ORDER_DRIVER_ASSIGNED');
    return { success: true };
  }

  async updateDeliveryStatus(userId: string, orderId: string, status: string, confirmPhoto?: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    const delivery = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (!delivery) throw new NotFoundException('Delivery not found');
    if (delivery.driverId !== driver.id) throw new ForbiddenException();

    await this.prisma.delivery.update({
      where: { orderId },
      data: {
        status: status as any,
        ...(confirmPhoto && { confirmPhoto }),
        ...(status === 'DELIVERED' && { deliveredTime: new Date() }),
        ...(status === 'PICKED_UP' && { pickupTime: new Date() }),
      },
    });

    if (status === 'DELIVERED') {
      await this.prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' as any } });
      await this.creditAfterDelivery(orderId, driver.id);
    }
    await this.notifications.sendOrderNotification(orderId, status === 'DELIVERED' ? 'ORDER_DELIVERED' : 'ORDER_IN_DELIVERY');
    return { success: true };
  }

  async getDashboard(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException();

    const today = new Date(); today.setHours(0,0,0,0);
    const [todayDeliveries, allDeliveries, avgRating] = await Promise.all([
      this.prisma.delivery.count({ where: { driverId: driver.id, status: 'DELIVERED', createdAt: { gte: today } } }),
      this.prisma.delivery.count({ where: { driverId: driver.id, status: 'DELIVERED' } }),
      this.prisma.review.aggregate({ where: { driverId: driver.id }, _avg: { driverRating: true } }),
    ]);

    const earnings = await this.prisma.transaction.aggregate({
      where: { driverId: driver.id, type: 'DELIVERY_FEE', status: 'COMPLETED' },
      _sum: { amount: true },
    });

    return { data: { todayDeliveries, allDeliveries, avgRating: avgRating._avg.driverRating, totalEarnings: earnings._sum.amount ?? 0 } };
  }

  private async creditAfterDelivery(orderId: string, driverId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    // Credit driver delivery fee
    await this.prisma.transaction.create({
      data: { driverId, type: 'DELIVERY_FEE', amount: order.deliveryFee, currency: order.currency, status: 'COMPLETED', description: `Delivery for order ${orderId}` },
    });

    // Credit professional (total - commission)
    const prof = await this.prisma.professional.findUnique({ where: { id: order.professionalId } });
    const profAmount = order.subtotal - order.commissionAmount;
    await this.prisma.transaction.create({
      data: { professionalId: order.professionalId, type: 'PAYOUT', amount: profAmount, currency: order.currency, status: 'PENDING', description: `Revenue for order ${orderId}` },
    });

    // Platform commission
    await this.prisma.transaction.create({
      data: { type: 'COMMISSION', amount: order.commissionAmount, currency: order.currency, status: 'COMPLETED', description: `Commission for order ${orderId}` },
    });
  }
}
