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
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';

@WebSocketGateway({
  namespace: '/tracking',
  // CORS restreint au frontend configuré ; pour le mobile (origin null/absent),
  // socket.io accepte par défaut.
  cors: { origin: process.env.FRONTEND_URL ?? false, credentials: true },
})
export class DeliveriesGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;

  constructor(
    private prisma: PrismaService,
    private wsJwtGuard: WsJwtGuard,
    private config: ConfigService,
  ) {}

  /** Authentifie chaque connexion entrante. Disconnect si token invalide. */
  handleConnection(client: Socket) {
    this.wsJwtGuard.authenticate(client);
  }

  /** Le livreur émet sa position. On vérifie que le driver émetteur est bien lui. */
  @SubscribeMessage('driver_location')
  async updateDriverLocation(
    @MessageBody() data: { orderId: string; driverId: string; lat: number; lng: number },
    @ConnectedSocket() client: Socket,
  ) {
    const user = (client.handshake as any).user;
    if (!user) throw new WsException('Unauthorized');

    // Le driverId du payload doit appartenir à l'utilisateur authentifié
    const driver = await this.prisma.driver.findUnique({ where: { id: data.driverId } });
    if (!driver || driver.userId !== user.id) {
      throw new WsException('Forbidden: not your driver profile');
    }

    await this.prisma.driver.update({
      where: { id: data.driverId },
      data: { currentLat: data.lat, currentLng: data.lng },
    });
    await this.prisma.delivery.updateMany({
      where: { orderId: data.orderId },
      data: { driverLat: data.lat, driverLng: data.lng },
    });
    this.server.to(`order_${data.orderId}`).emit('location_update', { lat: data.lat, lng: data.lng });
  }

  /** Un client/livreur s'abonne au tracking d'une commande dont il est partie prenante. */
  @SubscribeMessage('track_order')
  async handleTrackOrder(
    @MessageBody() data: { orderId: string },
    @ConnectedSocket() socket: Socket,
  ) {
    const user = (socket.handshake as any).user;
    if (!user) throw new WsException('Unauthorized');

    const order = await this.prisma.order.findUnique({
      where: { id: data.orderId },
      select: { clientId: true, professionalId: true },
    });
    if (!order) throw new WsException('Order not found');

    // Seul le client, le pro associé ou un livreur peut tracker
    const pro = await this.prisma.professional.findUnique({ where: { id: order.professionalId }, select: { userId: true } });
    const isClient = order.clientId === user.id;
    const isPro = pro?.userId === user.id;
    const isDriver = user.role === 'DRIVER';
    if (!isClient && !isPro && !isDriver) {
      throw new WsException('Forbidden');
    }

    socket.join(`order_${data.orderId}`);
  }
}
