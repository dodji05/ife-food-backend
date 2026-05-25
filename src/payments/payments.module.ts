import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeService } from './gateways/stripe.service';
import { PaypalService } from './gateways/paypal.service';
import { KkiapayService } from './gateways/kkiapay.service';
import { FedapayService } from './gateways/fedapay.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';

@Module({
  // NotificationsModule exporte NotificationsService — utilisé par
  // confirmPayment() pour notifier le pro qu'une nouvelle commande PAID
  // est arrivée (déclencheur clé du workflow pro).
  // DeliveriesModule exporte DeliveriesGateway — utilisé pour broadcast
  // `new_mission` aux drivers en ligne dès qu'une commande est PAID.
  imports: [NotificationsModule, DeliveriesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeService, PaypalService, KkiapayService, FedapayService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
