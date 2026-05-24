import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderStatusDto } from './dto/order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('orders')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new order' })
  createOrder(@CurrentUser() user: any, @Body() dto: CreateOrderDto) {
    return this.ordersService.createOrder(user.id, dto);
  }

  @Get('my-orders')
  @ApiOperation({ summary: 'Get client order history' })
  getMyOrders(@CurrentUser() user: any, @Query() pagination: PaginationDto) {
    return this.ordersService.getClientOrders(user.id, pagination);
  }

  @Get('professional')
  @ApiOperation({ summary: 'Get professional orders' })
  getProfessionalOrders(
    @CurrentUser() user: any,
    @Query() pagination: PaginationDto,
    @Query('status') status?: string,
  ) {
    return this.ordersService.getProfessionalOrders(user.professional?.id, pagination, status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order details' })
  getOrder(@Param('id') id: string, @CurrentUser() user: any) {
    return this.ordersService.getOrderById(id, user.id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update order status (professional/driver)' })
  updateStatus(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: UpdateOrderStatusDto) {
    return this.ordersService.updateOrderStatus(id, user.id, dto);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel an order (client)' })
  cancelOrder(@Param('id') id: string, @CurrentUser() user: any, @Body('reason') reason: string) {
    return this.ordersService.cancelOrder(id, user.id, reason);
  }

  @Post(':id/reorder')
  @ApiOperation({ summary: 'Reorder from previous order' })
  reorder(@Param('id') id: string, @CurrentUser() user: any) {
    return this.ordersService.reorderFromPrevious(id, user.id);
  }

  @Post(':id/tip')
  @ApiOperation({ summary: 'Leave a tip for the driver after delivery' })
  submitTip(@Param('id') id: string, @CurrentUser() user: any, @Body('amount') amount: number) {
    return this.ordersService.submitTip(user.id, id, Number(amount));
  }

  @Post(':id/assign-driver/:driverUserId')
  @ApiOperation({ summary: 'Professional manually assigns a favorite driver' })
  assignDriver(
    @Param('id') id: string,
    @Param('driverUserId') driverUserId: string,
    @CurrentUser() user: any,
  ) {
    return this.ordersService.assignDriver(id, driverUserId, user.id);
  }
}
