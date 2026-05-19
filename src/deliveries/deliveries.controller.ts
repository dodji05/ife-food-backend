import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
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

  // Historique des missions terminées du driver connecté
  // (DELIVERED + CANCELLED). Utilisé par mission_history_screen mobile.
  @Get('driver/history')
  @ApiOperation({ summary: 'Get past deliveries of the connected driver' })
  getDriverHistory(@CurrentUser() user: any) {
    return this.deliveriesService.getDriverHistory(user.id);
  }
}
