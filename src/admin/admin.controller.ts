import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('admin')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private adminService: AdminService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get admin dashboard KPIs' })
  getDashboard(@Query('period') period: string, @Query('country') country?: string) {
    return this.adminService.getDashboard(period, country);
  }

  // ANALYTICS
  @Get('analytics')
  @ApiOperation({ summary: 'Get advanced analytics' })
  getAnalytics(@Query('period') period: string, @Query('country') country?: string) {
    return this.adminService.getAnalytics(period, country);
  }

  // VALIDATIONS
  @Get('pending/professionals')
  getPendingProfessionals() { return this.adminService.getPendingProfessionals(); }

  @Get('pending/drivers')
  getPendingDrivers() { return this.adminService.getPendingDrivers(); }

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
  getUsers(@Query() query: any) {
    const { page, limit, role, country } = query;
    const pagination = new PaginationDto();
    if (page) pagination.page = Number(page);
    if (limit) pagination.limit = Number(limit);
    return this.adminService.getUsers(role, pagination, country);
  }

  @Patch('users/:id/status')
  updateUserStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.adminService.updateUserStatus(id, status);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  // PROFESSIONALS (all)
  @Get('professionals')
  getAllProfessionals(@Query() query: any) {
    const pagination = new PaginationDto();
    if (query.page) pagination.page = Number(query.page);
    if (query.limit) pagination.limit = Number(query.limit);
    return this.adminService.getAllProfessionals(pagination);
  }

  // DRIVERS (all)
  @Get('drivers')
  getAllDrivers(@Query() query: any) {
    const pagination = new PaginationDto();
    if (query.page) pagination.page = Number(query.page);
    if (query.limit) pagination.limit = Number(query.limit);
    return this.adminService.getAllDrivers(pagination);
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
  @Put('config/commission')
  setCommission(@Body() body: { type: 'PERCENTAGE' | 'FIXED_AMOUNT'; value: number; perCategory?: any }) {
    return this.adminService.setCommissionConfig(body.type, body.value, body.perCategory);
  }

  @Put('config/payment-gateways')
  setGateways(@Body() body: Record<string, boolean>) {
    return this.adminService.setPaymentGateways(body);
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

  // FINANCES
  @Get('finances/report')
  getFinancialReport(@Query('from') from: string, @Query('to') to: string) {
    return this.adminService.getFinancialReport(from, to);
  }
}
