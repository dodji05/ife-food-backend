import {
  Controller, Post, Get, Body, Res, Req, UseGuards, HttpCode, UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response, Request } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto, AdminRequestResetDto, AdminConfirmResetDto } from './dto/admin-auth.dto';

@ApiTags('admin-auth')
@Controller('auth/admin')
export class AdminAuthController {
  constructor(private adminAuthService: AdminAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Admin login via email + password' })
  async login(
    @Body() dto: AdminLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.adminAuthService.login(dto, res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refresh admin access token via cookie' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.refreshToken;
    if (!token) throw new UnauthorizedException('Refresh token manquant');
    return this.adminAuthService.refreshFromCookie(token, res);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin logout — clear cookies' })
  logout(@Res({ passthrough: true }) res: Response) {
    return this.adminAuthService.logout(res);
  }

  @Public()
  @Post('request-reset')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Request password reset via OTP SMS' })
  requestReset(@Body() dto: AdminRequestResetDto) {
    return this.adminAuthService.requestReset(dto);
  }

  @Public()
  @Post('confirm-reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm password reset with OTP + new password' })
  confirmReset(@Body() dto: AdminConfirmResetDto) {
    return this.adminAuthService.confirmReset(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get current admin profile' })
  me(@CurrentUser() user: any) {
    return this.adminAuthService.getMe(user);
  }
}
