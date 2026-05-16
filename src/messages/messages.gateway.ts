import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MessagesService } from './messages.service';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';

@WebSocketGateway({
  namespace: '/messages',
  cors: { origin: process.env.FRONTEND_URL ?? false, credentials: true },
})
export class MessagesGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;

  constructor(
    private messagesService: MessagesService,
    private wsJwtGuard: WsJwtGuard,
  ) {}

  handleConnection(client: Socket) {
    this.wsJwtGuard.authenticate(client);
  }

  @SubscribeMessage('join')
  handleJoin(@MessageBody() data: { conversationId: string }, @ConnectedSocket() client: Socket) {
    const user = (client.handshake as any).user;
    if (!user) throw new WsException('Unauthorized');
    // TODO: vérifier que l'utilisateur fait bien partie de la conversation
    client.join(data.conversationId);
  }

  @SubscribeMessage('send')
  async handleMessage(
    @MessageBody() data: { conversationId: string; content: string },
    @ConnectedSocket() client: Socket,
  ) {
    const user = (client.handshake as any).user;
    if (!user) throw new WsException('Unauthorized');
    const message = await this.messagesService.sendMessage(user.id, data.conversationId, data.content);
    this.server.to(data.conversationId).emit('message', message);
    return message;
  }
}
