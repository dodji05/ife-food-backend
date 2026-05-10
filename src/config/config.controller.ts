import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ConfigAppService } from './config.service';

@ApiTags('config')
@Controller('config')
export class ConfigController {
  constructor(private configService: ConfigAppService) {}

  @Get('legal/:type/:lang')
  @Public()
  @ApiOperation({ summary: 'Get legal page content' })
  getLegal(@Param('type') type: string, @Param('lang') lang: string) {
    return this.configService.getLegalPage(type, lang);
  }

  @Get('banners')
  @Public()
  @ApiOperation({ summary: 'Get active banners' })
  getBanners(@Query('country') country?: string) {
    return this.configService.getBanners(country);
  }
}
