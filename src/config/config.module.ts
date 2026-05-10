import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { ConfigAppService } from './config.service';

@Module({ controllers: [ConfigController], providers: [ConfigAppService], exports: [ConfigAppService] })
export class ConfigAppModule {}
