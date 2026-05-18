import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProfessionalsModule } from './professionals/professionals.module';
import { DriversModule } from './drivers/drivers.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { ReviewsModule } from './reviews/reviews.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MessagesModule } from './messages/messages.module';
import { AdminModule } from './admin/admin.module';
import { GeoModule } from './geo/geo.module';
import { UploadsModule } from './uploads/uploads.module';
import { UserAddressesModule } from './user-addresses/user-addresses.module';
import { PromoModule } from './promo/promo.module';
import { ConfigAppModule } from './config/config.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        { ttl: config.get('THROTTLE_TTL', 60) * 1000, limit: config.get('THROTTLE_LIMIT', 100) },
      ],
    }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: config.get('REDIS_URL', 'redis://localhost:6379'),
      }),
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ProfessionalsModule,
    DriversModule,
    ProductsModule,
    OrdersModule,
    PaymentsModule,
    DeliveriesModule,
    ReviewsModule,
    NotificationsModule,
    MessagesModule,
    AdminModule,
    GeoModule,
    UploadsModule,
    UserAddressesModule,
    PromoModule,
    ConfigAppModule,
    TasksModule,
  ],
})
export class AppModule {}
