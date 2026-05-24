import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [NotificationsModule, DeliveriesModule, OrdersModule],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
