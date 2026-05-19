import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';

@Module({
  // DeliveriesModule importé pour injection de DeliveriesGateway dans
  // DriversService (Sprint C : emit order_status temps réel aux clients).
  imports: [NotificationsModule, DeliveriesModule],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
