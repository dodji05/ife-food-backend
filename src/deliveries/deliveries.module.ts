import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesGateway } from './deliveries.gateway';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET', 'change_me_in_production_min_32_chars'),
      }),
    }),
  ],
  controllers: [DeliveriesController],
  providers: [DeliveriesService, DeliveriesGateway, WsJwtGuard],
  // Export du gateway : OrdersService / PaymentsService peuvent émettre
  // l'évènement temps réel `new_mission` aux livreurs en ligne.
  exports: [DeliveriesService, DeliveriesGateway],
})
export class DeliveriesModule {}
