import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  constructor(private config: ConfigService, private prisma: PrismaService) {}

  /** Calculate distance in km using Haversine formula */
  calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad(deg: number) { return deg * (Math.PI / 180); }

  /** Calculate delivery fee based on zones or distance */
  async calculateDeliveryFee(
    fromLat: number, fromLng: number,
    toLat: number, toLng: number,
    fromCity?: string, toCity?: string,
  ): Promise<number> {
    // Check city-based zones first
    if (fromCity && toCity) {
      const zone = await this.prisma.deliveryZone.findFirst({
        where: { fromCity, toCity, isActive: true },
      });
      if (zone) {
        const distance = this.calculateDistance(fromLat, fromLng, toLat, toLng);
        const weatherMultiplier = await this.getWeatherMultiplier(toLat, toLng);
        return (Number(zone.baseFee) + Number(zone.perKmFee) * distance) * weatherMultiplier;
      }
    }

    // Distance-based fallback
    const distance = this.calculateDistance(fromLat, fromLng, toLat, toLng);
    const globalFeeConfig = await this.prisma.platformConfig.findUnique({ where: { key: 'deliveryFeePerKm' } });
    const perKm = globalFeeConfig?.value != null ? Number(globalFeeConfig.value) : 150; // 150 XOF/km default
    const weatherMultiplier = await this.getWeatherMultiplier(toLat, toLng);
    return Math.round(distance * perKm * weatherMultiplier);
  }

  /** Get weather multiplier for delivery fee */
  async getWeatherMultiplier(lat: number, lng: number): Promise<number> {
    try {
      const apiKey = this.config.get('WEATHER_API_KEY');
      if (!apiKey) return 1;

      const { data } = await axios.get(`${this.config.get('WEATHER_API_URL')}/weather`, {
        params: { lat, lon: lng, appid: apiKey },
      });

      const weatherId = data.weather[0].id;
      // Bad weather: thunderstorm (2xx), heavy rain (5xx > 521), snow (6xx)
      if (weatherId < 300 || (weatherId >= 502 && weatherId < 600) || (weatherId >= 600 && weatherId < 700)) {
        return 1.3; // 30% surcharge for bad weather
      }
      return 1;
    } catch {
      return 1; // Default no multiplier
    }
  }

  /** Get nearby professionals */
  async getNearbyProfessionals(lat: number, lng: number, radiusKm: number = 10, category?: string) {
    // Mode test : si GEO_DISABLE_FILTER=true, on retourne TOUS les pros
    // VALIDATED sans filtre géo ni isOpen. Utile en early stage quand on
    // n'a que quelques comptes test sans coords précises. À retirer
    // (ou passer à false) quand on aura un vrai pool de pros géolocalisés.
    const testMode = this.config.get('GEO_DISABLE_FILTER') === 'true';

    const professionals = await this.prisma.professional.findMany({
      where: {
        status: 'VALIDATED',
        ...(testMode ? {} : { isOpen: true }),
        ...(category && { category: category as any }),
      },
      include: { reviews: { select: { professionalRating: true } } },
    });

    const mapped = professionals.map((p) => {
      // Si lat/lng du pro absents en test mode, on force distance=0.
      const proLat = p.lat != null ? Number(p.lat) : lat;
      const proLng = p.lng != null ? Number(p.lng) : lng;
      const distance = this.calculateDistance(lat, lng, proLat, proLng);
      const avgRating = p.reviews.length
        ? p.reviews.reduce((s, r) => s + (r.professionalRating ?? 0), 0) / p.reviews.length
        : 0;
      return { ...p, distance: Math.round(distance * 10) / 10, avgRating: Math.round(avgRating * 10) / 10 };
    });

    if (testMode) {
      // En test, on retourne tout, trié par nom alphabétique.
      return mapped.sort((a, b) => a.businessName.localeCompare(b.businessName));
    }

    return mapped
      .filter((p) => p.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance);
  }

  async getExchangeRate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    try {
      const cached = await this.prisma.exchangeRate.findUnique({ where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } } });
      if (cached && new Date().getTime() - cached.updatedAt.getTime() < 24 * 60 * 60 * 1000) return Number(cached.rate);

      const apiKey = this.config.get('EXCHANGE_RATE_API_KEY');
      const { data } = await axios.get(`${this.config.get('EXCHANGE_RATE_API_URL')}/${apiKey}/latest/${from}`);
      const rate = data.conversion_rates[to];

      await this.prisma.exchangeRate.upsert({
        where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
        update: { rate },
        create: { fromCurrency: from, toCurrency: to, rate },
      });
      return rate;
    } catch {
      return 1;
    }
  }
}
