import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PromoService } from './promo.service';
import { ValidatePromoDto } from './dto/validate-promo.dto';

@ApiTags('promo')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('promo')
export class PromoController {
  constructor(private promoService: PromoService) {}

  @Post('validate')
  @ApiOperation({ summary: 'Valider un code promo (read-only, ne consomme pas d\'use)' })
  validate(@CurrentUser() user: any, @Body() dto: ValidatePromoDto) {
    return this.promoService.validate(dto, user.id);
  }
}
