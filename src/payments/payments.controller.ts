import { Controller, Post, Get, Param, Headers, Req, Res, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import { Request, Response } from 'express';

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
    // rawBody (Buffer) → vérification HMAC-SHA256 (FedaPay, Stripe).
    // body (objet parsé) → lecture des champs de l'événement.
    const rawBody = (req as any).rawBody ?? req.body;
    const parsedBody = req.body;
    const sig = stripeSig || fedapaySig || '';
    return this.paymentsService.handleWebhook(gateway, parsedBody, rawBody, sig);
  }

  @Post(':orderId/check-fedapay')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Manually check FedaPay transaction status and confirm if approved' })
  checkFedapay(@Param('orderId') orderId: string) {
    return this.paymentsService.checkFedapayPayment(orderId);
  }

  @Get('gateways')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get available payment gateways' })
  getGateways() {
    return this.paymentsService.getActiveGateways();
  }

  /**
   * Page de retour FedaPay après paiement (callback_url).
   * FedaPay redirige ici après que l'utilisateur valide ou annule son paiement.
   * Retourne une page HTML minimaliste qui invite l'utilisateur à fermer le
   * navigateur et retourner dans l'application.
   */
  @Get('fedapay-return')
  @Public()
  @ApiOperation({ summary: 'FedaPay payment return page (callback_url target)' })
  fedapayReturn(
    @Query('status') status: string,
    @Query('transaction_id') transactionId: string,
    @Res() res: Response,
  ) {
    const success = !status || status === 'approved';
    const emoji   = success ? '✅' : '⚠️';
    const title   = success ? 'Paiement effectué' : 'Paiement non finalisé';
    const message = success
      ? 'Votre paiement a bien été reçu. Fermez cette fenêtre pour retourner dans ifè FOOD.'
      : 'Le paiement n\'a pas abouti. Fermez cette fenêtre et réessayez depuis l\'application.';
    const color = success ? '#1A6B3C' : '#F59E0B';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title} — ifè FOOD</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f7f5; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; padding: 24px;
    }
    .card {
      background: #fff; border-radius: 20px; padding: 40px 32px;
      text-align: center; max-width: 380px; width: 100%;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .emoji { font-size: 56px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 800; color: ${color}; margin-bottom: 12px; }
    p  { font-size: 15px; color: #64748b; line-height: 1.6; margin-bottom: 28px; }
    .btn {
      display: inline-block; background: ${color}; color: #fff;
      border: none; border-radius: 14px; padding: 14px 32px;
      font-size: 15px; font-weight: 700; cursor: pointer; width: 100%;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">${emoji}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <button class="btn" onclick="window.close()">Fermer et retourner dans l'app</button>
  </div>
  <script>
    // Tente de fermer automatiquement (fonctionne si ouvert via window.open)
    // Chrome Custom Tab l'ignore mais affiche le bouton à la place.
    setTimeout(function() { try { window.close(); } catch(e) {} }, 1500);
  </script>
</body>
</html>`);
  }
}
