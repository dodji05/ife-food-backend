import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ReviewsService } from './reviews.service';

@ApiTags('reviews')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('reviews')
export class ReviewsController {
  constructor(private reviewsService: ReviewsService) {}

  @Post('orders/:orderId')
  createReview(@CurrentUser() user: any, @Param('orderId') orderId: string, @Body() body: any) {
    return this.reviewsService.createReview(user.id, orderId, body.professionalRating, body.driverRating, body.professionalComment, body.driverComment);
  }

  @Post(':id/reply')
  replyToReview(@CurrentUser() user: any, @Param('id') id: string, @Body('reply') reply: string) {
    return this.reviewsService.replyToReview(user.id, id, reply);
  }

  @Get('professional/:id')
  @Public()
  getProfessionalReviews(@Param('id') id: string) {
    return this.reviewsService.getProfessionalReviews(id);
  }
}
