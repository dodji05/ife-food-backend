import { Controller, Post, Get, Query, Body, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { SendOtpDto, VerifyOtpDto, SetPinDto, VerifyPinDto, Verify2faDto } from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Throttle } from '@nestjs/throttler';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('otp/send')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Send OTP to phone number' })
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto.phone, dto.countryCode);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  // Limite brute-force : 10 essais / minute / IP (l'OtpService applique aussi
  // un compteur d'attempts par sessionId).
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Verify OTP code and login/register' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.code, dto.sessionId, dto.role);
  }

  @Public()
  @Post('pin/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Login with PIN' })
  verifyPin(@Body() dto: VerifyPinDto) {
    return this.authService.verifyPin(dto.phone, dto.pin);
  }

  @Post('pin/set')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Set PIN for authenticated user' })
  setPin(@CurrentUser() user: any, @Body() dto: SetPinDto) {
    return this.authService.setPin(user.id, dto.pin);
  }

  @Public()
  @Get('exists')
  @ApiOperation({ summary: 'Check if a phone number is registered' })
  checkPhoneExists(@Query('phone') phone: string) {
    return this.authService.checkPhoneExists(phone);
  }

  @Post('2fa/verify')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Verify 2FA TOTP code (admins)' })
  verify2fa(@CurrentUser() user: any, @Body() dto: Verify2faDto) {
    return this.authService.verify2fa(user.id, dto.code);
  }
}
