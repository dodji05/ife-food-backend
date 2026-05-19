import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { GeoModule } from '../geo/geo.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';

@Module({
  imports: [NotificationsModule, PaymentsModule, GeoModule, DeliveriesModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
