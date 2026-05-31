import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DriversService } from './drivers.service';
import { OrdersService } from '../orders/orders.service';
import { CreateDriverDto, UpdateDriverDto, UpdateLocationDto, SelectDriverZoneDto } from './dto/driver.dto';

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

  @Get('me/available-missions')
  @ApiOperation({ summary: 'List missions available to accept (acceptance window still open)' })
  getAvailableMissions(@CurrentUser() user: any) {
    return this.ordersService.getAvailableMissions(user.id);
  }

  @Get('me/earnings')
  @ApiOperation({ summary: 'List driver earnings' })
  getEarnings(@CurrentUser() user: any) {
    return this.driversService.getEarnings(user.id);
  }

  @Post('me/withdrawal')
  @ApiOperation({ summary: 'Request a payout withdrawal' })
  requestWithdrawal(@CurrentUser() user: any, @Body('amount') amount: number) {
    return this.driversService.requestWithdrawal(user.id, amount);
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
    @Body('confirmCode') confirmCode?: string,
  ) {
    return this.driversService.updateDeliveryStatus(user.id, orderId, status, photo, confirmCode);
  }

  // ── Zones de livraison (sélection parmi zones admin) ────────────────────

  @Get('me/zones')
  @ApiOperation({ summary: 'All admin delivery zones with selected flag for this driver' })
  getZones(@CurrentUser() user: any) {
    return this.driversService.getZones(user.id);
  }

  @Post('me/zones/:zoneId/select')
  @ApiOperation({ summary: 'Select a delivery zone' })
  addZone(@CurrentUser() user: any, @Param('zoneId') zoneId: string) {
    return this.driversService.addZone(user.id, { deliveryZoneId: zoneId });
  }

  @Delete('me/zones/:zoneId')
  @ApiOperation({ summary: 'Deselect a delivery zone' })
  deleteZone(@CurrentUser() user: any, @Param('zoneId') zoneId: string) {
    return this.driversService.deleteZone(user.id, zoneId);
  }

  // ── Documents ────────────────────────────────────────────────────────────────

  @Get('me/documents')
  @ApiOperation({ summary: 'List driver documents' })
  getDocuments(@CurrentUser() user: any) {
    return this.driversService.getDocuments(user.id);
  }

  @Post('me/documents')
  @ApiOperation({ summary: 'Upload a driver document (ID card or license)' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      cb(allowed.includes(file.mimetype) ? null : new Error('File type not allowed'), allowed.includes(file.mimetype));
    },
  }))
  uploadDocument(
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('docType') docType: string,
  ) {
    return this.driversService.uploadDocument(user.id, file, docType);
  }
}
