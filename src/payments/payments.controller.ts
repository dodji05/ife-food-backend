import { Controller, Post, Get, Param, Headers, Req, Res, Query, UseGuards, Header } from '@nestjs/common';
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
    @Res() res: Response,
  ): void {
    const success = !status || status === 'approved';
    const color   = success ? '#1A6B3C' : '#F59E0B';
    const bgColor = success ? '#F0FFF4' : '#FFFBEB';
    const title   = success ? 'Paiement effectue !' : 'Paiement non finalise';
    const message = success
      ? 'Votre paiement a bien ete recu par ife FOOD.'
      : 'Le paiement n\'a pas abouti. Reessayez depuis l\'application.';
    const icon    = success ? '&#10003;' : '&#9888;';

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — ife FOOD</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      background:${bgColor};
      min-height:100vh;
      display:flex;align-items:center;justify-content:center;
      padding:24px;
    }
    .card{
      background:#fff;
      border-radius:24px;
      padding:48px 32px 40px;
      text-align:center;
      max-width:400px;width:100%;
      box-shadow:0 8px 40px rgba(0,0,0,0.10);
    }
    .circle{
      width:80px;height:80px;border-radius:50%;
      background:${color};
      display:flex;align-items:center;justify-content:center;
      margin:0 auto 24px;
      font-size:36px;color:#fff;font-weight:900;
    }
    h1{font-size:24px;font-weight:800;color:#1a1d1b;margin-bottom:12px}
    .sub{font-size:15px;color:#64748b;line-height:1.6;margin-bottom:8px}
    .hint{
      display:flex;align-items:center;justify-content:center;gap:8px;
      margin:24px 0 32px;
      background:#f8fafc;border-radius:12px;padding:14px 16px;
      font-size:13px;color:#475569;font-weight:600;
    }
    .arrow{font-size:20px}
    .badge{
      display:inline-block;
      background:${color}18;
      color:${color};
      border:1.5px solid ${color}40;
      border-radius:10px;
      padding:10px 16px;
      font-size:13px;font-weight:700;
      margin-bottom:8px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="circle">${icon}</div>
    <h1>${title}</h1>
    <p class="sub">${message}</p>

    <div class="hint">
      <span class="arrow">&#8592;</span>
      <span>Appuyez sur la fleche retour pour revenir dans l'application</span>
    </div>

    <div class="badge">ife FOOD</div>
    <p style="font-size:11px;color:#94a3b8;margin-top:8px">Powered by FedaPay</p>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  }
}
