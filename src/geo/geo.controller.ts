import { Controller, Get, Query, UseGuards, ParseFloatPipe, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { GeoService } from './geo.service';

@ApiTags('geo')
@Controller('geo')
export class GeoController {
  constructor(private geoService: GeoService) {}

  @Get('nearby')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get nearby open professionals' })
  getNearby(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
    @Query('radius', new DefaultValuePipe(10), ParseFloatPipe) radius: number,
    @Query('category') category?: string,
  ) {
    return this.geoService.getNearbyProfessionals(lat, lng, radius, category);
  }

  @Get('exchange-rate')
  @Public()
  @ApiOperation({ summary: 'Get exchange rate between currencies' })
  getExchangeRate(@Query('from') from: string, @Query('to') to: string) {
    return this.geoService.getExchangeRate(from, to);
  }

  @Get('delivery-fee')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Calculate delivery fee' })
  getDeliveryFee(
    @Query('fromLat', ParseFloatPipe) fromLat: number,
    @Query('fromLng', ParseFloatPipe) fromLng: number,
    @Query('toLat', ParseFloatPipe) toLat: number,
    @Query('toLng', ParseFloatPipe) toLng: number,
    @Query('fromCity') fromCity?: string,
    @Query('toCity') toCity?: string,
  ) {
    return this.geoService.calculateDeliveryFee(fromLat, fromLng, toLat, toLng, fromCity, toCity);
  }
}
