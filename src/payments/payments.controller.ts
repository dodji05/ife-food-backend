import { Controller, Post, Get, Param, Headers, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import { Request } from 'express';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  @Post(':orderId/initiate/:gateway')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Initiate payment for an order' })
  initiatePayment(@Param('orderId') orderId: string, @Param('gateway') gateway: string) {
    return this.paymentsService.initiatePayment(orderId, gateway.toUpperCase());
  }

  @Post('webhooks/:gateway')
  @Public()
  @ApiOperation({ summary: 'Receive payment gateway webhooks' })
  webhook(
    @Param('gateway') gateway: string,
    @Req() req: Request,
    @Headers('stripe-signature') stripeSig: string,
    @Headers('x-fedapay-signature') fedapaySig: string,
  ) {
    const payload = (req as any).rawBody ?? req.body;
    const sig = stripeSig || fedapaySig || '';
    return this.paymentsService.handleWebhook(gateway, payload, sig);
  }

  @Get('gateways')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get available payment gateways' })
  getGateways() {
    return this.paymentsService.getActiveGateways();
  }
}
