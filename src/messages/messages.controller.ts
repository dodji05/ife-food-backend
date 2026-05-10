import { Controller, Get, Post, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MessagesService } from './messages.service';

@ApiTags('messages')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('messages')
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  @Post(':conversationId')
  sendMessage(@CurrentUser() user: any, @Param('conversationId') convId: string, @Body('content') content: string) {
    return this.messagesService.sendMessage(user.id, convId, content);
  }

  @Get(':conversationId')
  getConversation(@CurrentUser() user: any, @Param('conversationId') convId: string) {
    return this.messagesService.getConversation(convId, user.id);
  }

  @Patch(':conversationId/read')
  markRead(@Param('conversationId') convId: string) {
    return this.messagesService.markRead(convId);
  }
}
