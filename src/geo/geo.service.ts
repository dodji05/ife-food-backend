import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';
import { computeIsOpen } from '../common/utils/opening-hours.util';

@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  constructor(private config: ConfigService, private prisma: PrismaService) {}

  /**
   * Calcule la distance routière réelle via Google Routes API (v2).
   * Fallback automatique sur Haversine si la clé est absente ou l'API indisponible.
   * @returns distance en km (route réelle ou vol d'oiseau en fallback)
   */
  async getRoutingDistance(
    originLat: number, originLng: number,
    destLat: number,   destLng: number,
  ): Promise<number> {
    const apiKey = this.config.get<string>('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      this.logger.warn('GOOGLE_MAPS_API_KEY absent — fallback Haversine pour la distance');
      return this.calculateDistance(originLat, originLng, destLat, destLng);
    }

    try {
      const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';
      const { data } = await axios.post(
        url,
        {
          origin:      { location: { latLng: { latitude: originLat, longitude: originLng } } },
          destination: { location: { latLng: { latitude: destLat,   longitude: destLng   } } },
          travelMode:        'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
        },
        {
          params: { key: apiKey },
          headers: {
            'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
            'Content-Type':     'application/json',
          },
          timeout: 5000,
        },
      );

      const route = data?.routes?.[0];
      if (route?.distanceMeters) {
        const km = route.distanceMeters / 1000;
        this.logger.log(`Routes API: ${km.toFixed(2)} km (route réelle)`);
        return km;
      }

      this.logger.warn('Routes API: aucune route retournée — fallback Haversine');
    } catch (err: any) {
      this.logger.warn(`Routes API error: ${err.message} — fallback Haversine`);
    }

    return this.calculateDistance(originLat, originLng, destLat, destLng);
  }

  /** Calculate distance in km using Haversine formula */
  calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad(deg: number) { return deg * (Math.PI / 180); }

  /** Calculate delivery fee based on the active delivery mode */
  async calculateDeliveryFee(
    fromLat: unknown, fromLng: unknown,
    toLat: unknown, toLng: unknown,
    fromCity?: string, toCity?: string,
  ): Promise<number> {
    const modeCfg = await this.prisma.platformConfig.findUnique({ where: { key: 'deliveryModeConfig' } });
    const activeMode: string = (modeCfg?.value as any)?.activeMode ?? 'zone';

    // Guard: Prisma Decimal fields arrive as Decimal | null at runtime despite TS typing.
    // Number(null) === 0 est fini → sans guard, null donne (0,0) = équateur.
    const safe = (v: unknown, fallback: number): number => {
      if (v == null) return fallback;
      const n = Number(v);
      return isFinite(n) ? n : fallback;
    };
    const sFromLat = safe(fromLat, 6.36);
    const sFromLng = safe(fromLng, 2.42);
    const sToLat   = safe(toLat,   6.36);
    const sToLng   = safe(toLng,   2.42);

    const distance = await this.getRoutingDistance(sFromLat, sFromLng, sToLat, sToLng);
    const weatherMultiplier = await this.getWeatherMultiplier(sToLat, sToLng);

    // ── city mode : tarif fixe par paire de villes ──────────────────────────
    if (activeMode === 'city') {
      const fc = fromCity?.trim();
      const tc = toCity?.trim();
      if (fc && tc) {
        const zone = await this.prisma.deliveryZone.findFirst({
          where: {
            fromCity: { equals: fc, mode: 'insensitive' },
            toCity:   { equals: tc, mode: 'insensitive' },
            isActive: true,
          },
        });
        if (zone) return Math.round(Number(zone.baseFee) * weatherMultiplier);
        // Aucune zone configurée pour ce trajet — fallback global
        this.logger.warn(`City mode: no zone for ${fc} → ${tc}, falling back to distance`);
      }
    }

    // ── km mode : config globale unique (baseFee + perKmFee) ───────────────
    if (activeMode === 'km') {
      const kmCfg = await this.prisma.platformConfig.findUnique({ where: { key: 'kmDeliveryConfig' } });
      const raw    = (kmCfg?.value as any) ?? {};
      const baseFee  = Number(raw.baseFee  ?? 500);
      const perKmFee = Number(raw.perKmFee ?? 150);
      const fee = Math.round((baseFee + perKmFee * distance) * weatherMultiplier);
      this.logger.log(
        `KM mode (global): baseFee=${baseFee} + ${distance.toFixed(2)}km × ${perKmFee} = ${(baseFee + perKmFee * distance).toFixed(2)} × weather${weatherMultiplier} → ${fee} XOF`,
      );
      return fee;
    }

    // ── zone mode : tarif fixe — matching par ville de livraison ───────────
    if (activeMode === 'zone') {
      const tc = toCity?.trim();
      let zone = null;

      if (tc) {
        // 1. Correspondance exacte sur toCity (insensible à la casse)
        zone = await this.prisma.deliveryZone.findFirst({
          where: { toCity: { equals: tc, mode: 'insensitive' }, fromCity: null, perKmFee: { lte: 0 }, isActive: true },
        });
        // 2. Correspondance sur le nom de la zone
        if (!zone) {
          zone = await this.prisma.deliveryZone.findFirst({
            where: { name: { contains: tc, mode: 'insensitive' }, perKmFee: { lte: 0 }, isActive: true },
          });
        }
      }
      // 3. Première zone active comme filet de sécurité
      if (!zone) {
        zone = await this.prisma.deliveryZone.findFirst({
          where: { fromCity: null, perKmFee: { lte: 0 }, isActive: true },
          orderBy: { createdAt: 'asc' },
        });
      }

      if (zone) {
        const fee = Math.round(Number(zone.baseFee) * weatherMultiplier);
        this.logger.log(
          `Zone mode: zone="${zone.name}" baseFee=${zone.baseFee} × weather${weatherMultiplier} → ${fee} XOF`,
        );
        return fee;
      }

      this.logger.warn(`Zone mode: no active zone for toCity="${toCity ?? '?'}", falling back to distance`);
    }

    // ── fallback global : distance × perKm ─────────────────────────────────
    const globalFeeConfig = await this.prisma.platformConfig.findUnique({ where: { key: 'deliveryFeePerKm' } });
    const perKm = globalFeeConfig?.value != null ? Number(globalFeeConfig.value) : 150;
    return Math.round(distance * perKm * weatherMultiplier);
  }

  /** Resolve professional coordinates by ID */
  async getProfessionalCoords(professionalId: string): Promise<{ lat: number; lng: number; city: string | undefined } | null> {
    const pro = await this.prisma.professional.findUnique({
      where: { id: professionalId },
      select: { lat: true, lng: true, city: true },
    });
    if (!pro || pro.lat == null || pro.lng == null) return null;
    return { lat: Number(pro.lat), lng: Number(pro.lng), city: pro.city ?? undefined };
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
    // Retourne TOUS les pros VALIDATED — les fermés sont inclus intentionnellement
    // pour que le client puisse consulter les menus et planifier une commande.
    // Le statut isOpen est affiché côté mobile (badge Ouvert/Fermé) mais ne
    // filtre plus la liste de découverte.
    const testMode = this.config.get('GEO_DISABLE_FILTER') !== 'false';

    const professionals = await this.prisma.professional.findMany({
      where: {
        status: 'VALIDATED',
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
      return {
        ...p,
        distance:  Math.round(distance  * 10) / 10,
        avgRating: Math.round(avgRating * 10) / 10,
        isOpen:    computeIsOpen(p.isOpen, p.openingHours),
      };
    });

    if (testMode) {
      // En test, on retourne tout, trié par nom alphabétique.
      return mapped.sort((a, b) => a.businessName.localeCompare(b.businessName));
    }

    return mapped
      .filter((p) => p.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * Clé + URL Exchange Rate : priorité à la config admin (DB), fallback .env.
   * Centralisé ici, réutilisé par TasksService.
   */
  async getExchangeRateConfig(): Promise<{ apiKey: string; apiUrl: string }> {
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'exchangeRateCredentials' } });
    const raw = (cfg?.value as any) ?? {};
    return {
      apiKey: raw.apiKey || this.config.get('EXCHANGE_RATE_API_KEY', ''),
      apiUrl: raw.apiUrl || this.config.get('EXCHANGE_RATE_API_URL', 'https://v6.exchangerate-api.com/v6'),
    };
  }

  async getExchangeRate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    try {
      const cached = await this.prisma.exchangeRate.findUnique({ where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } } });
      if (cached && new Date().getTime() - cached.updatedAt.getTime() < 24 * 60 * 60 * 1000) return Number(cached.rate);

      const { apiKey, apiUrl } = await this.getExchangeRateConfig();
      if (!apiKey || apiKey.includes('your_')) return cached ? Number(cached.rate) : 1;
      const { data } = await axios.get(`${apiUrl}/${apiKey}/latest/${from}`);
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
