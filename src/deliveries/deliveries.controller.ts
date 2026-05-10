import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DeliveriesService } from './deliveries.service';

@ApiTags('deliveries')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('deliveries')
export class DeliveriesController {
  constructor(private deliveriesService: DeliveriesService) {}

  @Get('order/:orderId')
  getDeliveryStatus(@Param('orderId') orderId: string) {
    return this.deliveriesService.getDeliveryStatus(orderId);
  }

  @Get('order/:orderId/position')
  getDriverPosition(@Param('orderId') orderId: string) {
    return this.deliveriesService.getDriverPosition(orderId);
  }
}
