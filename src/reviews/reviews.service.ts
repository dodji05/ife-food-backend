import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}

  async createReview(reviewerId: string, orderId: string, professionalRating: number, driverRating: number, professionalComment?: string, driverComment?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.clientId !== reviewerId) throw new ForbiddenException();
    if (order.status !== 'DELIVERED') throw new BadRequestException('Can only review delivered orders');

    const existing = await this.prisma.review.findUnique({ where: { orderId } });
    if (existing) throw new BadRequestException('Review already submitted');

    return this.prisma.review.create({
      data: { orderId, reviewerId, professionalId: order.professionalId, driverId: order.driverId, professionalRating, driverRating, professionalComment, driverComment },
    });
  }

  async replyToReview(userId: string, reviewId: string, reply: string) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId }, include: { professional: true } });
    if (!review) throw new NotFoundException();
    if (review.professional?.userId !== userId) throw new ForbiddenException();
    return this.prisma.review.update({ where: { id: reviewId }, data: { professionalReply: reply } });
  }

  async getProfessionalReviews(professionalId: string) {
    const reviews = await this.prisma.review.findMany({
      where: { professionalId, isModerated: false },
      include: { reviewer: { select: { name: true, firstName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const avg = reviews.length
      ? reviews.reduce((s, r) => s + (r.professionalRating ?? 0), 0) / reviews.length
      : 0;
    return { data: { reviews, average: Math.round(avg * 10) / 10, count: reviews.length } };
  }
}
