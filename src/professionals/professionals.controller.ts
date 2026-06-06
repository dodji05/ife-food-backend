import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards, ParseIntPipe, DefaultValuePipe, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ProfessionalsService } from './professionals.service';
import { CreateProfessionalDto, UpdateProfessionalDto, UpdateOpeningHoursDto } from './dto/professional.dto';

@ApiTags('professionals')
@UseGuards(JwtAuthGuard)
@Controller('professionals')
export class ProfessionalsController {
  constructor(private professionalsService: ProfessionalsService) {}

  @Post('register')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Register as a professional' })
  register(@CurrentUser() user: any, @Body() dto: CreateProfessionalDto) {
    return this.professionalsService.register(user.id, dto);
  }

  @Get('me')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get my professional profile' })
  getMyProfile(@CurrentUser() user: any) {
    return this.professionalsService.getMyProfile(user.id);
  }

  @Get('me/dashboard')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get professional dashboard KPIs' })
  getDashboard(@CurrentUser() user: any) {
    return this.professionalsService.getDashboard(user.id);
  }

  @Get('me/earnings')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get professional earnings breakdown' })
  getEarnings(
    @CurrentUser() user: any,
    @Query('period', new DefaultValuePipe(30), ParseIntPipe) period: number,
  ) {
    const days = [7, 30, 90].includes(period) ? period : 30;
    return this.professionalsService.getEarnings(user.id, days);
  }

  @Post('me/withdrawal')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Request a payout withdrawal' })
  requestWithdrawal(
    @CurrentUser() user: any,
    @Body('amount') amount: number,
    @Body('paymentInfo') paymentInfo?: string,
  ) {
    return this.professionalsService.requestWithdrawal(user.id, amount, paymentInfo);
  }

  @Patch('me')
  @ApiBearerAuth('JWT')
  updateProfile(@CurrentUser() user: any, @Body() dto: UpdateProfessionalDto) {
    return this.professionalsService.updateProfile(user.id, dto);
  }

  @Patch('me/toggle-open')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Toggle open/closed status' })
  toggleOpen(@CurrentUser() user: any) {
    return this.professionalsService.toggleOpen(user.id);
  }

  @Patch('me/opening-hours')
  @ApiBearerAuth('JWT')
  updateHours(@CurrentUser() user: any, @Body() dto: UpdateOpeningHoursDto) {
    return this.professionalsService.updateOpeningHours(user.id, dto);
  }

  @Get('me/favorite-drivers')
  @ApiBearerAuth('JWT')
  getFavoriteDrivers(@CurrentUser() user: any) {
    return this.professionalsService.getFavoriteDrivers(user.id);
  }

  @Post('me/favorite-drivers/:driverId')
  @ApiBearerAuth('JWT')
  addFavoriteDriver(@CurrentUser() user: any, @Param('driverId') driverId: string) {
    return this.professionalsService.addFavoriteDriver(user.id, driverId);
  }

  @Delete('me/favorite-drivers/:driverId')
  @ApiBearerAuth('JWT')
  removeFavoriteDriver(@CurrentUser() user: any, @Param('driverId') driverId: string) {
    return this.professionalsService.removeFavoriteDriver(user.id, driverId);
  }

  @Patch('me/favorite-drivers/:driverId/mark-private')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Mark a favorite driver as private (exclusive to this pro)' })
  markDriverPrivate(
    @CurrentUser() user: any,
    @Param('driverId') driverId: string,
    @Body('isPrivate') isPrivate: boolean,
  ) {
    return this.professionalsService.markDriverPrivate(user.id, driverId, isPrivate);
  }

  @Get('me/drivers/search')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Search a driver by phone number to add to favorites' })
  searchDriver(@CurrentUser() user: any, @Query('phone') phone: string) {
    return this.professionalsService.searchDriverByPhone(user.id, phone);
  }

  // ── Promo codes (pro-side) ───────────��──────────────────────────────────
  @Get('me/promo-codes')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'List professional promo codes' })
  listPromoCodes(@CurrentUser() user: any) {
    return this.professionalsService.listPromoCodes(user.id);
  }

  @Post('me/promo-codes')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Create a promo code for this professional' })
  createPromoCode(@CurrentUser() user: any, @Body() dto: any) {
    return this.professionalsService.createPromoCode(user.id, dto);
  }

  @Patch('me/promo-codes/:promoId')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Update a professional promo code' })
  updatePromoCode(@CurrentUser() user: any, @Param('promoId') promoId: string, @Body() dto: any) {
    return this.professionalsService.updatePromoCode(user.id, promoId, dto);
  }

  @Delete('me/promo-codes/:promoId')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Delete a professional promo code' })
  deletePromoCode(@CurrentUser() user: any, @Param('promoId') promoId: string) {
    return this.professionalsService.deletePromoCode(user.id, promoId);
  }

  // ── Reviews ───────────────────────────────────────────────────────────────
  @Get('me/reviews')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get my reviews' })
  getReviews(@CurrentUser() user: any) {
    return this.professionalsService.getReviews(user.id);
  }

  // ── Documents ─────────────────────────────────────────────────────────────
  @Get('me/documents')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'List professional documents' })
  getDocuments(@CurrentUser() user: any) {
    return this.professionalsService.getDocuments(user.id);
  }

  @Post('me/documents')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Upload a professional document' })
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
    return this.professionalsService.uploadDocument(user.id, file, docType);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get public professional profile with products' })
  getPublicProfile(@Param('id') id: string) {
    return this.professionalsService.getPublicProfile(id);
  }
}
