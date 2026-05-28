import { Controller, Get, Query, UseGuards, DefaultValuePipe, ParseFloatPipe } from '@nestjs/common';
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
    // lat/lng OPTIONNELS : si absents on prend Cotonou par défaut (6.36, 2.42).
    // Utile pour le mode test GEO_DISABLE_FILTER où la distance n'est pas
    // utilisée comme filtre, et pour les clients qui n'ont pas autorisé
    // la géolocalisation sur leur device.
    @Query('lat', new DefaultValuePipe(6.36), ParseFloatPipe) lat: number,
    @Query('lng', new DefaultValuePipe(2.42), ParseFloatPipe) lng: number,
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
  @ApiOperation({ summary: 'Estimate delivery fee — accepts professionalId or explicit fromLat/fromLng' })
  async getDeliveryFee(
    @Query('toLat', ParseFloatPipe) toLat: number,
    @Query('toLng', ParseFloatPipe) toLng: number,
    @Query('fromLat') fromLatStr?: string,
    @Query('fromLng') fromLngStr?: string,
    @Query('professionalId') professionalId?: string,
    @Query('fromCity') fromCity?: string,
    @Query('toCity') toCity?: string,
  ) {
    let resolvedFromLat = fromLatStr ? parseFloat(fromLatStr) : undefined;
    let resolvedFromLng = fromLngStr ? parseFloat(fromLngStr) : undefined;
    let resolvedFromCity = fromCity;

    if (professionalId && (resolvedFromLat === undefined || resolvedFromLng === undefined)) {
      const coords = await this.geoService.getProfessionalCoords(professionalId);
      if (coords) {
        resolvedFromLat ??= coords.lat;
        resolvedFromLng ??= coords.lng;
        resolvedFromCity ??= coords.city;
      }
    }

    return this.geoService.calculateDeliveryFee(
      resolvedFromLat ?? 6.36, resolvedFromLng ?? 2.42,
      toLat, toLng,
      resolvedFromCity, toCity,
    );
  }
}
