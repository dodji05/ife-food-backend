import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeService } from './gateways/stripe.service';
import { PaypalService } from './gateways/paypal.service';
import { KkiapayService } from './gateways/kkiapay.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule exporte NotificationsService — utilisé par
  // confirmPayment() pour notifier le pro qu'une nouvelle commande PAID
  // est arrivée (déclencheur clé du workflow pro).
  imports: [NotificationsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeService, PaypalService, KkiapayService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
