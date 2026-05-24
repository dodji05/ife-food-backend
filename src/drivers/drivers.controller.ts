import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DriversService } from './drivers.service';
import { OrdersService } from '../orders/orders.service';
import { CreateDriverDto, UpdateDriverDto, UpdateLocationDto, CreateDriverZoneDto, UpdateDriverZoneDto } from './dto/driver.dto';

@ApiTags('drivers')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('drivers')
export class DriversController {
  constructor(
    private driversService: DriversService,
    private ordersService: OrdersService,
  ) {}

  @Post('register')
  register(@CurrentUser() user: any, @Body() dto: CreateDriverDto) {
    return this.driversService.register(user.id, dto);
  }

  @Get('me')
  getMyProfile(@CurrentUser() user: any) {
    return this.driversService.getMyProfile(user.id);
  }

  @Get('me/dashboard')
  getDashboard(@CurrentUser() user: any) {
    return this.driversService.getDashboard(user.id);
  }

  @Get('me/active-missions')
  @ApiOperation({ summary: 'List ongoing deliveries' })
  getActiveMissions(@CurrentUser() user: any) {
    return this.driversService.getActiveMissions(user.id);
  }

  @Get('me/earnings')
  @ApiOperation({ summary: 'List driver earnings' })
  getEarnings(@CurrentUser() user: any) {
    return this.driversService.getEarnings(user.id);
  }

  @Get('config')
  @ApiOperation({ summary: 'Driver-facing config (timeout, nav provider)' })
  getConfig() {
    return this.driversService.getDriverConfig();
  }

  @Patch('me')
  updateProfile(@CurrentUser() user: any, @Body() dto: UpdateDriverDto) {
    return this.driversService.updateProfile(user.id, dto);
  }

  @Patch('me/toggle-availability')
  @ApiOperation({ summary: 'Go online/offline' })
  toggleAvailability(@CurrentUser() user: any) {
    return this.driversService.toggleAvailability(user.id);
  }

  @Patch('me/location')
  @ApiOperation({ summary: 'Update GPS position' })
  @Throttle({ default: { limit: 30, ttl: 10000 } })
  updateLocation(@CurrentUser() user: any, @Body() dto: UpdateLocationDto) {
    return this.driversService.updateLocation(user.id, dto);
  }

  @Post('missions/:orderId/accept')
  @ApiOperation({ summary: 'Accept a delivery mission' })
  async acceptMission(@CurrentUser() user: any, @Param('orderId') orderId: string) {
    const result = await this.driversService.acceptMission(user.id, orderId);
    // Annule le timeout de réattribution — la commande est prise.
    this.ordersService.clearPendingDispatch(orderId);
    return result;
  }

  @Post('missions/:orderId/decline')
  @ApiOperation({ summary: 'Decline a delivery mission — triggers reassignment' })
  async declineMission(@CurrentUser() user: any, @Param('orderId') orderId: string) {
    await this.ordersService.handleDriverDecline(orderId, user.id);
    return { success: true };
  }

  @Patch('missions/:orderId/status')
  @ApiOperation({ summary: 'Update delivery status' })
  updateDeliveryStatus(
    @CurrentUser() user: any,
    @Param('orderId') orderId: string,
    @Body('status') status: string,
    @Body('confirmPhoto') photo?: string,
  ) {
    return this.driversService.updateDeliveryStatus(user.id, orderId, status, photo);
  }

  // ── Zones de livraison ───────────────────────────────────────────────────

  @Get('me/zones')
  @ApiOperation({ summary: 'List driver activity zones' })
  getZones(@CurrentUser() user: any) {
    return this.driversService.getZones(user.id);
  }

  @Post('me/zones')
  @ApiOperation({ summary: 'Add an activity zone' })
  addZone(@CurrentUser() user: any, @Body() dto: CreateDriverZoneDto) {
    return this.driversService.addZone(user.id, dto);
  }

  @Patch('me/zones/:zoneId')
  @ApiOperation({ summary: 'Update an activity zone' })
  updateZone(
    @CurrentUser() user: any,
    @Param('zoneId') zoneId: string,
    @Body() dto: UpdateDriverZoneDto,
  ) {
    return this.driversService.updateZone(user.id, zoneId, dto);
  }

  @Delete('me/zones/:zoneId')
  @ApiOperation({ summary: 'Delete an activity zone' })
  deleteZone(@CurrentUser() user: any, @Param('zoneId') zoneId: string) {
    return this.driversService.deleteZone(user.id, zoneId);
  }
}
