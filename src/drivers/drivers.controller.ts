import { Controller, Get, Post, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { DriversService } from './drivers.service';
import { CreateDriverDto, UpdateDriverDto, UpdateLocationDto } from './dto/driver.dto';

@ApiTags('drivers')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('drivers')
export class DriversController {
  constructor(private driversService: DriversService) {}

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
  @ApiOperation({ summary: 'Update GPS position (every 5 seconds)' })
  updateLocation(@CurrentUser() user: any, @Body() dto: UpdateLocationDto) {
    return this.driversService.updateLocation(user.id, dto);
  }

  @Post('missions/:orderId/accept')
  @ApiOperation({ summary: 'Accept a delivery mission' })
  acceptMission(@CurrentUser() user: any, @Param('orderId') orderId: string) {
    return this.driversService.acceptMission(user.id, orderId);
  }

  @Patch('missions/:orderId/status')
  @ApiOperation({ summary: 'Update delivery status' })
  updateDeliveryStatus(@CurrentUser() user: any, @Param('orderId') orderId: string, @Body('status') status: string, @Body('confirmPhoto') photo?: string) {
    return this.driversService.updateDeliveryStatus(user.id, orderId, status, photo);
  }
  @Get('me/active-missions')
  @UseGuards(RolesGuard)
  @Roles('DRIVER')
  @ApiOperation({ summary: 'Get all active delivery missions' })
  getActiveMissions(@CurrentUser() user: any) {
    return this.driversService.getActiveMissions(user.id);
  }

  @Get('me/earnings')
  @ApiOperation({ summary: 'Get driver earnings history' })
  getEarnings(@CurrentUser() user: any) {
    return this.driversService.getEarnings(user.id);
  }

  @Patch(':id/capacity')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Admin: update driver max concurrent deliveries' })
  updateCapacity(
    @Param('id') driverId: string,
    @Body('maxConcurrentDeliveries') max: number,
  ) {
    return this.driversService.updateCapacity(driverId, max);
  }
}
