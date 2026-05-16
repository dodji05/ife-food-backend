import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MessagesGateway } from './messages.gateway';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET', 'change_me_in_production_min_32_chars'),
      }),
    }),
  ],
  controllers: [MessagesController],
  providers: [MessagesService, MessagesGateway, WsJwtGuard],
  exports: [MessagesService],
})
export class MessagesModule {}
