import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('admin')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard, AdminGuard)
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private adminService: AdminService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get admin dashboard KPIs' })
  getDashboard(@Query('period') period: string) {
    return this.adminService.getDashboard(period);
  }

  // VALIDATIONS
  @Get('pending/professionals')
  getPendingProfessionals() { return this.adminService.getPendingProfessionals(); }

  @Get('pending/drivers')
  getPendingDrivers() { return this.adminService.getPendingDrivers(); }

  @Get('professionals')
  getAllProfessionals(@Query() pagination: PaginationDto) { return this.adminService.getAllProfessionals(pagination); }

  @Patch('professionals/:id/validate')
  validateProfessional(@Param('id') id: string, @Body() body: { status: 'VALIDATED' | 'REJECTED'; note?: string }) {
    return this.adminService.validateProfessional(id, body.status, body.note);
  }

  @Patch('drivers/:id/validate')
  validateDriver(@Param('id') id: string, @Body() body: { status: 'VALIDATED' | 'REJECTED'; note?: string }) {
    return this.adminService.validateDriver(id, body.status, body.note);
  }

  // USERS
  @Get('users')
  getUsers(@Query('role') role: string, @Query() pagination: PaginationDto) {
    return this.adminService.getUsers(role, pagination);
  }

  @Patch('users/:id/status')
  updateUserStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.adminService.updateUserStatus(id, status);
  }

  // ORDERS
  // All query params are merged into a single object; AdminService separates
  // pagination fields (page, limit) from filter fields internally.
  @Get('orders')
  getAllOrders(@Query() query: any) {
    const { page, limit, ...filters } = query;
    const pagination = new PaginationDto();
    if (page) pagination.page = Number(page);
    if (limit) pagination.limit = Number(limit);
    return this.adminService.getAllOrders(filters, pagination);
  }

  @Patch('orders/:id/reassign')
  reassignDriver(@Param('id') id: string, @Body('driverId') driverId: string) {
    return this.adminService.reassignDriver(id, driverId);
  }

  // CONFIG
  @Get('config/platform')
  getPlatformConfig() { return this.adminService.getPlatformConfig(); }

  @Put('config/platform')
  setPlatformConfig(@Body() body: any) { return this.adminService.setPlatformConfig(body); }

  // FIX: Endpoint GET manquant — le frontend admin en a besoin pour charger la commission courante
  @Get('config/commission')
  getCommission() { return this.adminService.getCommissionConfig(); }

  @Put('config/commission')
  setCommission(@Body() body: { type: 'PERCENTAGE' | 'FIXED_AMOUNT'; value: number; perCategory?: any }) {
    return this.adminService.setCommissionConfig(body.type, body.value, body.perCategory);
  }

  @Put('config/payment-gateways')
  setGateways(@Body() body: Record<string, boolean>) {
    return this.adminService.setPaymentGateways(body);
  }

  // FIX: Endpoint manquant — appelé par le Header admin pour le badge de notifications
  @Get('notifications/unread-count')
  getNotificationsCount(@CurrentUser() user: any) {
    return this.adminService.getAdminNotificationsCount(user.id);
  }

  // PROMO CODES
  @Get('promo-codes')
  getPromoCodes() { return this.adminService.getPromoCodes(); }

  @Post('promo-codes')
  createPromoCode(@Body() dto: any) { return this.adminService.createPromoCode(dto); }

  // LEGAL PAGES
  @Get('legal/:type/:lang')
  getLegalPage(@Param('type') type: string, @Param('lang') lang: string) {
    return this.adminService.getLegalPage(type, lang);
  }

  @Put('legal/:type/:lang')
  upsertLegalPage(@Param('type') type: string, @Param('lang') lang: string, @Body() body: any) {
    return this.adminService.upsertLegalPage(type, lang, body.title, body.content, body.version);
  }

  // BANNERS
  @Get('banners')
  getBanners() { return this.adminService.getBanners(); }

  @Post('banners')
  createBanner(@Body() dto: any) { return this.adminService.createBanner(dto); }

  @Put('banners/:id')
  updateBanner(@Param('id') id: string, @Body() dto: any) { return this.adminService.updateBanner(id, dto); }

  @Delete('banners/:id')
  deleteBanner(@Param('id') id: string) { return this.adminService.deleteBanner(id); }

  // DELIVERY ZONES
  @Get('delivery-zones')
  getDeliveryZones() { return this.adminService.getDeliveryZones(); }

  @Post('delivery-zones')
  upsertDeliveryZone(@Body() dto: any) { return this.adminService.upsertDeliveryZone(dto); }

  // NOTIFICATIONS
  @Post('notifications/broadcast')
  broadcast(@Body() body: { title: string; body: string; role?: string; countries?: string[] }) {
    return this.adminService.broadcastNotification(body.title, body.body, body.role, body.countries);
  }

  // CATALOGUE
  @Get('catalogue/products')
  getAllProducts(@Query() pagination: PaginationDto) { return this.adminService.getAllProducts(pagination); }

  // PAYMENT STATS
  @Get('payments/stats')
  getPaymentStats() { return this.adminService.getPaymentStats(); }

  // ANALYTICS
  @Get('analytics')
  getAnalytics() { return this.adminService.getAnalytics(); }

  // FINANCES
  @Get('finances/report')
  getFinancialReport(@Query('from') from: string, @Query('to') to: string) {
    return this.adminService.getFinancialReport(from, to);
  }
}
