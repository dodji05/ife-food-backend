import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({ namespace: '/tracking', cors: { origin: '*' } })
export class DeliveriesGateway {
  @WebSocketServer() server: Server;
  constructor(private prisma: PrismaService) {}

  @SubscribeMessage('driver_location')
  async updateDriverLocation(@MessageBody() data: { orderId: string; driverId: string; lat: number; lng: number }) {
    await this.prisma.driver.update({ where: { id: data.driverId }, data: { currentLat: data.lat, currentLng: data.lng } });
    await this.prisma.delivery.updateMany({ where: { orderId: data.orderId }, data: { driverLat: data.lat, driverLng: data.lng } });
    this.server.to(`order_${data.orderId}`).emit('location_update', { lat: data.lat, lng: data.lng });
  }

  @SubscribeMessage('track_order')
  handleTrackOrder(@MessageBody() data: { orderId: string }, @ConnectedSocket() socket: Socket) {
    socket.join(`order_${data.orderId}`);
  }
}
