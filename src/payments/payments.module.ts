import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeService } from './gateways/stripe.service';
import { PaypalService } from './gateways/paypal.service';
import { KkiapayService } from './gateways/kkiapay.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeService, PaypalService, KkiapayService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
