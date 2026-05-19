import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; role: string }) {
    // Inclure professional + driver pour que les controllers puissent
    // référencer user.professional?.id et user.driver?.id (sans devoir
    // refaire un findUnique). Fix critique : sans cet include, l'onglet
    // commandes pro était cassé (user.professional?.id = undefined ->
    // GET /orders/professional renvoyait une liste vide).
    // Select minimal sur les relations pour ne pas surcharger le token check.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        professional: { select: { id: true, status: true } },
        driver:       { select: { id: true, status: true } },
      },
    });
    if (!user || user.status === 'BANNED') throw new UnauthorizedException();
    return user;
  }
}
