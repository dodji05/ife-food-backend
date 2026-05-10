import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MessagesService } from './messages.service';

@WebSocketGateway({ namespace: '/messages', cors: { origin: '*' } })
export class MessagesGateway {
  @WebSocketServer() server: Server;
  constructor(private messagesService: MessagesService) {}

  @SubscribeMessage('join')
  handleJoin(@MessageBody() data: { conversationId: string }, @ConnectedSocket() client: Socket) {
    client.join(data.conversationId);
  }

  @SubscribeMessage('send')
  async handleMessage(
    @MessageBody() data: { conversationId: string; content: string },
    @ConnectedSocket() client: Socket,
  ) {
    // SECURITY: never trust senderId from the client payload — read it from the
    // authenticated socket handshake data (set by a WS auth guard / middleware).
    const senderId: string = (client.handshake as any).user?.id ?? (client.handshake.auth as any)?.userId;
    if (!senderId) {
      client.emit('error', { message: 'Unauthorized' });
      return;
    }
    const message = await this.messagesService.sendMessage(senderId, data.conversationId, data.content);
    this.server.to(data.conversationId).emit('message', message);
    return message;
  }
}
