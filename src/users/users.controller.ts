import { Controller, Get, Post, Patch, Delete, Body, UseGuards, Ip, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { UpdateProfileDto, UpdateLangDto, UpdateCountryDto, UpdateFcmTokenDto, AcceptLegalDto } from './dto/user.dto';

@ApiTags('users')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  getMe(@CurrentUser() user: any) {
    return { data: user };
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update profile' })
  updateProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Patch('me/language')
  @ApiOperation({ summary: 'Update language preference' })
  updateLanguage(@CurrentUser() user: any, @Body() dto: UpdateLangDto) {
    return this.usersService.updateLanguage(user.id, dto);
  }

  @Patch('me/country')
  @ApiOperation({ summary: 'Update country and currency' })
  updateCountry(@CurrentUser() user: any, @Body() dto: UpdateCountryDto) {
    return this.usersService.updateCountry(user.id, dto.countryCode, dto.currency);
  }

  @Patch('me/fcm-token')
  @ApiOperation({ summary: 'Update FCM push token' })
  updateFcmToken(@CurrentUser() user: any, @Body() dto: UpdateFcmTokenDto) {
    return this.usersService.updateFcmToken(user.id, dto.fcmToken);
  }

  @Post('me/legal/accept')
  @ApiOperation({ summary: 'Record legal document acceptance' })
  acceptLegal(@CurrentUser() user: any, @Body() dto: AcceptLegalDto, @Ip() ip: string) {
    return this.usersService.acceptLegal(user.id, dto.documentType, dto.version, ip);
  }

  @Get('me/referral-code')
  @ApiOperation({ summary: 'Get or generate own referral code' })
  getReferralCode(@CurrentUser() user: any) {
    return this.usersService.getOrCreateReferralCode(user.id);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete account (soft delete)' })
  deleteAccount(@CurrentUser() user: any) {
    return this.usersService.deleteAccount(user.id);
  }
}
