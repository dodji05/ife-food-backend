import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({ namespace: '/tracking', cors: { origin: '*' } })
export class DeliveriesGateway {
  @WebSocketServer() server: Server;
  constructor(private prisma: PrismaService) {}

  /**
   * MODIFIÉ : mise à jour GPS du livreur.
   * Broadcast la position sur TOUTES les rooms des commandes actives du livreur,
   * pas seulement sur l'orderId fourni en payload.
   *
   * Compatibilité : si le client n'envoie qu'un orderId (ancien comportement),
   * ça continue de fonctionner car on broadcast sur toutes ses missions actives.
   */
  @SubscribeMessage('driver_location')
  async updateDriverLocation(
    @MessageBody() data: { orderId: string; driverId: string; lat: number; lng: number },
  ) {
    // Mise à jour position driver
    await this.prisma.driver.update({
      where: { id: data.driverId },
      data: { currentLat: data.lat, currentLng: data.lng },
    });

    // Mise à jour de TOUTES les livraisons actives de ce livreur (pas seulement data.orderId)
    await this.prisma.delivery.updateMany({
      where: {
        driverId: data.driverId,
        status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] },
      },
      data: { driverLat: data.lat, driverLng: data.lng },
    });

    // Broadcast sur TOUTES les rooms des commandes actives de ce livreur
    const activeDeliveries = await this.prisma.delivery.findMany({
      where: {
        driverId: data.driverId,
        status: { in: ['ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'IN_DELIVERY'] },
      },
      select: { orderId: true },
    });

    for (const delivery of activeDeliveries) {
      this.server.to(`order_${delivery.orderId}`).emit('location_update', {
        lat: data.lat,
        lng: data.lng,
        driverId: data.driverId,
      });
    }
  }

  /**
   * Inchangé : le client s'abonne à sa room de suivi.
   */
  @SubscribeMessage('track_order')
  handleTrackOrder(@MessageBody() data: { orderId: string }, @ConnectedSocket() socket: Socket) {
    socket.join(`order_${data.orderId}`);
  }

  /**
   * NOUVEAU : le livreur s'abonne à une room par mission active.
   * L'app Flutter appelle ceci pour chaque mission acceptée.
   */
  @SubscribeMessage('join_mission')
  handleJoinMission(@MessageBody() data: { orderId: string }, @ConnectedSocket() socket: Socket) {
    socket.join(`order_${data.orderId}`);
  }

  /**
   * NOUVEAU : le livreur quitte une room quand sa livraison est terminée.
   */
  @SubscribeMessage('leave_mission')
  handleLeaveMission(@MessageBody() data: { orderId: string }, @ConnectedSocket() socket: Socket) {
    socket.leave(`order_${data.orderId}`);
  }
}
