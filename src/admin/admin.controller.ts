import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminLevelGuard } from '../common/guards/admin-level.guard';
import { AdminLevel } from '../common/decorators/admin-level.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { TasksService } from '../tasks/tasks.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('admin')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private adminService: AdminService, private tasksService: TasksService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get admin dashboard KPIs' })
  getDashboard(
    @Query('period') period: string,
    @Query('country') country?: string,
    @Query('city') city?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.adminService.getDashboard(period, country, city, from, to);
  }

  // ANALYTICS
  @Get('analytics')
  @ApiOperation({ summary: 'Get advanced analytics' })
  getAnalytics(
    @Query('period') period: string,
    @Query('country') country?: string,
    @Query('city') city?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.adminService.getAnalytics(period, country, city, from, to);
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
    const { page, limit, role, country, search } = query;
    const pagination = new PaginationDto();
    if (page) pagination.page = Number(page);
    if (limit) pagination.limit = Number(limit);
    return this.adminService.getUsers(role, pagination, country, search);
  }

  @Post('users')
  createUser(@Body() dto: any) {
    return this.adminService.createUser(dto);
  }

  @Patch('users/:id/profile')
  updateUserProfile(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateUserProfile(id, dto);
  }

  @Patch('users/:id/status')
  updateUserStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.adminService.updateUserStatus(id, status);
  }

  @Get('users/:id/referral-code')
  getReferralCode(@Param('id') id: string) {
    return this.adminService.getReferralCode(id);
  }

  @Post('users/:id/referral-code')
  ensureReferralCode(@Param('id') id: string) {
    return this.adminService.ensureReferralCode(id);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  // DRIVER DETAIL + MISSIONS
  @Get('drivers/:id')
  getDriverDetail(@Param('id') id: string) {
    return this.adminService.getDriverDetail(id);
  }

  @Get('drivers/:id/missions')
  getDriverMissions(@Param('id') id: string) {
    return this.adminService.getDriverMissions(id);
  }

  // PROFESSIONAL DETAIL + ORDERS
  @Get('professionals/:id')
  getProfessionalDetail(@Param('id') id: string) {
    return this.adminService.getProfessionalDetail(id);
  }

  @Get('professionals/:id/orders')
  getProfessionalOrders(@Param('id') id: string) {
    return this.adminService.getProfessionalOrders(id);
  }

  // PROFESSIONALS (all)
  @Get('professionals')
  getAllProfessionals(@Query() query: any) {
    const { page, limit, country, city, category, status } = query;
    const pagination = new PaginationDto();
    if (page) pagination.page = Number(page);
    if (limit) pagination.limit = Number(limit);
    return this.adminService.getAllProfessionals(pagination, { country, city, category, status });
  }

  @Post('professionals')
  createProfessional(@Body() dto: any) {
    return this.adminService.createProfessional(dto);
  }

  @Patch('professionals/:id/info')
  updateProfessional(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateProfessional(id, dto);
  }

  @Delete('professionals/:id')
  deleteProfessional(@Param('id') id: string) {
    return this.adminService.deleteProfessional(id);
  }

  @Get('professionals/:id/promo-codes')
  getProPromoCodes(@Param('id') id: string) {
    return this.adminService.getProPromoCodes(id);
  }

  // DRIVERS (all)
  @Get('drivers')
  getAllDrivers(@Query() query: any) {
    const { page, limit, country, city, vehicleType, status } = query;
    const pagination = new PaginationDto();
    if (page) pagination.page = Number(page);
    if (limit) pagination.limit = Number(limit);
    return this.adminService.getAllDrivers(pagination, { country, city, vehicleType, status });
  }

  @Post('drivers')
  createDriver(@Body() dto: any) {
    return this.adminService.createDriver(dto);
  }

  @Patch('drivers/:id/info')
  updateDriver(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateDriver(id, dto);
  }

  @Delete('drivers/:id')
  deleteDriver(@Param('id') id: string) {
    return this.adminService.deleteDriver(id);
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

  // ─── Liste des villes distinctes (pour alimenter les dropdowns de filtres
  //     sans charger toute la payload du dashboard).
  @Get('filters/cities')
  @ApiOperation({ summary: 'Distinct delivery cities for filter dropdowns' })
  getDistinctCities(@Query('country') country?: string) {
    return this.adminService.getDistinctCities(country);
  }

  @Patch('orders/:id/reassign')
  reassignDriver(@Param('id') id: string, @Body('driverId') driverId: string) {
    return this.adminService.reassignDriver(id, driverId);
  }

  // CONFIG
  @Get('config/commission')
  getCommission() { return this.adminService.getCommissionConfig(); }

  @Put('config/commission')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  setCommission(@Body() body: any) {
    return this.adminService.setCommissionConfig(body);
  }

  @Get('config/platform')
  getPlatform() { return this.adminService.getPlatformConfig(); }

  @Put('config/payment-gateways')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  setGateways(@Body() body: Record<string, boolean>) {
    return this.adminService.setPaymentGateways(body);
  }

  @Get('config/payment-credentials')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  getPaymentCredentials() { return this.adminService.getPaymentCredentials(); }

  @Put('config/payment-credentials')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  setPaymentCredentials(@Body() body: any) {
    return this.adminService.setPaymentCredentials(body);
  }

  @Get('config/otp-credentials')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  getOtpCredentials() { return this.adminService.getOtpCredentials(); }

  @Put('config/otp-credentials')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  setOtpCredentials(@Body() body: any) { return this.adminService.setOtpCredentials(body); }

  @Get('config/maps-credentials')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  getMapsCredentials() { return this.adminService.getMapsCredentials(); }

  @Put('config/maps-credentials')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  setMapsCredentials(@Body() body: any) { return this.adminService.setMapsCredentials(body); }

  @Get('config/exchange-rate-credentials')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  getExchangeRateCredentials() { return this.adminService.getExchangeRateCredentials(); }

  @Put('config/exchange-rate-credentials')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  setExchangeRateCredentials(@Body() body: any) { return this.adminService.setExchangeRateCredentials(body); }

  @Post('config/exchange-rate-credentials/refresh')
  @ApiOperation({ summary: 'Trigger manual exchange rate refresh and return stored rates' })
  async refreshExchangeRates() {
    try {
      await this.tasksService.triggerManualRefresh();
    } catch (err: any) {
      // Convertir en BadRequestException (400) pour que NestJS expose le message réel
      // au lieu du générique "Internal server error" (500).
      throw new BadRequestException(err?.message ?? 'Échec du rafraîchissement des taux de change');
    }
    return this.adminService.getCurrencies();
  }

  @Get('config/delivery-mode')
  getDeliveryModeConfig() { return this.adminService.getDeliveryModeConfig(); }

  @Put('config/delivery-mode')
  setDeliveryModeConfig(@Body('activeMode') activeMode: string) { return this.adminService.setDeliveryModeConfig(activeMode); }

  // PAYMENTS
  @Get('payments/stats')
  getPaymentStats() { return this.adminService.getPaymentStats(); }

  @Get('payments/commissions')
  getCommissionStats(@Query('country') country?: string) { return this.adminService.getCommissionStats(country); }

  @Get('payments/delivery-fee-stats')
  getDeliveryFeeStats() { return this.adminService.getDeliveryFeeStats(); }

  @Get('payments/transactions')
  getTransactions(@Query() query: any) {
    const { page, limit, ...filters } = query;
    const pagination = new PaginationDto();
    if (page)  pagination.page  = Number(page);
    if (limit) pagination.limit = Number(limit);
    return this.adminService.getTransactions(filters, pagination);
  }

  @Patch('transactions/:id/status')
  updateTransactionStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.adminService.updateTransactionStatus(id, status);
  }

  // CATALOGUE ADMIN
  @Get('catalogue/categories')
  getGlobalCategories() {
    return this.adminService.getGlobalCategories();
  }

  @Post('catalogue/categories')
  createGlobalCategory(@Body() dto: any) {
    return this.adminService.createGlobalCategory(dto);
  }

  @Get('catalogue/:proId')
  getCatalogueForPro(@Param('proId') proId: string) {
    return this.adminService.getCatalogueForPro(proId);
  }

  @Post('catalogue/:proId/categories')
  createCatalogueCategory(@Param('proId') proId: string, @Body() dto: any) {
    return this.adminService.createCatalogueCategory(proId, dto);
  }

  @Delete('catalogue/categories/:id')
  deleteCatalogueCategory(@Param('id') id: string) {
    return this.adminService.deleteCatalogueCategory(id);
  }

  @Post('catalogue/:proId/products')
  createCatalogueProduct(@Param('proId') proId: string, @Body() dto: any) {
    return this.adminService.createCatalogueProduct(proId, dto);
  }

  @Patch('catalogue/products/:id')
  updateCatalogueProduct(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateCatalogueProduct(id, dto);
  }

  @Delete('catalogue/products/:id')
  deleteCatalogueProduct(@Param('id') id: string) {
    return this.adminService.deleteCatalogueProduct(id);
  }

  @Patch('catalogue/products/:id/toggle')
  toggleCatalogueProduct(@Param('id') id: string) {
    return this.adminService.toggleCatalogueProduct(id);
  }

  @Post('catalogue/upload-image')
  @UseInterceptors(FileInterceptor('image', { storage: memoryStorage() }))
  uploadCatalogueImage(@UploadedFile() file: Express.Multer.File) {
    return this.adminService.uploadCatalogueImage(file);
  }

  // PROMO CODES
  @Get('promo-codes')
  getPromoCodes() { return this.adminService.getPromoCodes(); }

  @Post('promo-codes')
  createPromoCode(@Body() dto: any) { return this.adminService.createPromoCode(dto); }

  @Patch('promo-codes/:id')
  updatePromoCode(@Param('id') id: string, @Body() dto: any) { return this.adminService.updatePromoCode(id, dto); }

  @Patch('promo-codes/:id/toggle')
  togglePromoCode(@Param('id') id: string) { return this.adminService.togglePromoCode(id); }

  @Delete('promo-codes/:id')
  deletePromoCode(@Param('id') id: string) { return this.adminService.deletePromoCode(id); }

  // REFERRALS
  @Get('referrals')
  getReferrals() { return this.adminService.getReferrals(); }

  @Get('referral-links')
  getReferralLinks() { return this.adminService.getReferralLinks(); }

  @Get('referral-config')
  getReferralConfig() { return this.adminService.getReferralConfig(); }

  @Patch('referral-config')
  updateReferralConfig(@Body() body: { rewardAmount: number; enabled: boolean }) {
    return this.adminService.updateReferralConfig(body.rewardAmount, body.enabled);
  }

  // WALLET
  @Get('users/:id/wallet')
  getUserWallet(@Param('id') id: string) { return this.adminService.getUserWallet(id); }

  @Post('users/:id/wallet/adjust')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN', 'ADMIN')
  adjustWallet(@Param('id') id: string, @Body() body: { amount: number; type: 'ADMIN_CREDIT' | 'ADMIN_DEBIT'; description?: string }) {
    return this.adminService.adjustWallet(id, body.amount, body.type, body.description);
  }

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

  @Delete('delivery-zones/:id')
  deleteDeliveryZone(@Param('id') id: string) { return this.adminService.deleteDeliveryZone(id); }

  // MESSAGES
  @Get('messages/conversations')
  getAdminConversations(@Query('search') search?: string) {
    return this.adminService.getAllConversations(search);
  }

  @Get('messages/:conversationId')
  getAdminConversation(@Param('conversationId') conversationId: string) {
    return this.adminService.getAdminConversation(conversationId);
  }

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

  // PAYS
  @Get('config/countries')
  getCountries() { return this.adminService.getCountries(); }

  @Patch('config/countries/:code/toggle')
  toggleCountry(@Param('code') code: string) { return this.adminService.toggleCountry(code); }

  // DEVISES
  @Get('config/currencies')
  getCurrencies() { return this.adminService.getCurrencies(); }

  @Put('config/currencies')
  upsertCurrencies(@Body() body: { rates: { fromCurrency: string; rate: number }[] }) {
    return this.adminService.upsertCurrencies(body.rates);
  }

  // COMPTES ADMIN
  @Get('admins')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  getAdmins() { return this.adminService.getAdmins(); }

  @Post('admins')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  createAdminAccount(@Body() dto: any) { return this.adminService.createAdminAccount(dto); }

  @Patch('admins/:id')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  updateAdminAccount(@Param('id') id: string, @Body() dto: any) { return this.adminService.updateAdminAccount(id, dto); }

  @Patch('admins/:id/status')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  toggleAdminStatus(@Param('id') id: string, @Body('status') status: 'ACTIVE' | 'SUSPENDED') {
    return this.adminService.toggleAdminStatus(id, status);
  }

  @Delete('admins/:id')
  @UseGuards(AdminLevelGuard)
  @AdminLevel('SUPER_ADMIN')
  deleteAdminAccount(@Param('id') id: string) { return this.adminService.deleteAdminAccount(id); }

  // ─── CONFIG NOTIFICATIONS VIREMENT ──────────────────────────────────────────
  @Get('config/withdrawal-notification')
  getWithdrawalNotificationConfig() { return this.adminService.getWithdrawalNotificationConfig(); }

  @Put('config/withdrawal-notification')
  setWithdrawalNotificationConfig(@Body('email') email: string) {
    return this.adminService.setWithdrawalNotificationConfig(email);
  }
}
