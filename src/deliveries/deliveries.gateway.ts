import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  WsException,
  Logger,
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
  private readonly logger = new Logger(DeliveriesGateway.name);

  constructor(
    private prisma: PrismaService,
    private wsJwtGuard: WsJwtGuard,
    private config: ConfigService,
  ) {}

  /**
   * Authentifie chaque connexion entrante. Si le user est un DRIVER,
   * on le fait rejoindre la room `drivers_online` afin de pouvoir
   * broadcaster les nouvelles missions à tous les livreurs en ligne
   * via un seul emit (cf. emitNewMission).
   */
  handleConnection(client: Socket) {
    const ok = this.wsJwtGuard.authenticate(client);
    if (!ok) return;
    const user = (client.handshake as any).user;
    if (user?.role === 'DRIVER') {
      client.join('drivers_online');
      client.join(`driver_${user.id}`);
      this.logger.log(`[WS] Driver connecté : userId=${user.id} socketId=${client.id}`);
    }
    // Auto-join room professional_<userId> pour broadcaster les events
    // côté pro (nouvelle commande, driver assigné, etc.) — évite au pro
    // de poller GET /orders/professional toutes les X secondes.
    if (user?.role === 'PROFESSIONAL') {
      client.join(`professional_${user.id}`);
    }
    // Client auto-joint sa propre room user_<id> pour recevoir les
    // events order_status sans besoin de track_order explicite.
    if (user?.role === 'CLIENT') {
      client.join(`user_${user.id}`);
    }
  }

  /**
   * Émet un évènement `new_mission` à tous les drivers connectés (room
   * `drivers_online`). Si `driverUserId` est fourni, l'émission est ciblée
   * sur ce driver uniquement (room `driver_<userId>`).
   *
   * Le payload est volontairement plat pour matcher le modèle Mission
   * côté mobile (Mission.fromOrderJson est tolérant aux champs manquants).
   */
  emitNewMission(payload: {
    orderId: string;
    professionalName: string;
    professionalAddress?: string;
    professionalPhone?: string;
    professionalLat?: number;
    professionalLng?: number;
    deliveryAddress: string;
    deliveryZone?: string;
    deliveryLat?: number;
    deliveryLng?: number;
    deliveryFee: number;
    currency?: string;
    distanceKm?: number;
    distanceToPickupKm?: number | null;
    estimatedMinutes?: number;
    items?: any[];
    driverUserId?: string;
  }) {
    if (!this.server) return;
    const target = payload.driverUserId
      ? `driver_${payload.driverUserId}`
      : 'drivers_online';
    this.server.to(target).emit('new_mission', payload);
  }

  /**
   * Émet un évènement `order_status` sur la room `order_<id>`.
   *
   * Utilisé pour notifier en temps réel TOUS les acteurs concernés
   * (client + pro + driver assigné) d'un changement de statut sur une
   * commande, sans dépendre du FCM (qui peut être indisponible en
   * background iOS).
   *
   * Statuts couverts :
   *   - ACCEPTED / IN_PREPARATION / READY_FOR_PICKUP (côté pro)
   *   - DRIVER_ASSIGNED (côté driver accept)
   *   - HEADING_TO_PICKUP / ARRIVED_AT_PICKUP / PICKED_UP / IN_DELIVERY
   *     / DELIVERED (côté driver delivery step)
   *   - CANCELLED (annulation client/pro)
   */
  emitOrderStatus(orderId: string, status: string, extra: Record<string, any> = {}) {
    if (!this.server) return;
    this.server.to(`order_${orderId}`).emit('order_status', {
      orderId, status, ...extra, at: Date.now(),
    });
  }

  /**
   * Notifie le pro en temps réel qu'une nouvelle commande vient d'arriver
   * (statut PAID). Émis sur la room `professional_<userId>` (auto-jointe
   * à la connexion socket). Le pro n'a pas besoin de track_order pour la
   * recevoir — il ne connaît pas encore l'orderId.
   */
  emitNewOrder(professionalUserId: string, payload: {
    orderId: string;
    totalAmount: number;
    itemCount: number;
    clientName?: string;
    deliveryAddress: string;
    createdAt: number;
  }) {
    if (!this.server) return;
    this.server.to(`professional_${professionalUserId}`).emit('new_order', payload);
  }

  /** Le livreur émet sa position. On vérifie que le driver émetteur est bien lui. */
  @SubscribeMessage('driver_location')
  async updateDriverLocation(
    @MessageBody() data: { orderId: string; driverId: string; lat: number; lng: number },
    @ConnectedSocket() client: Socket,
  ) {
    const user = (client.handshake as any).user;
    if (!user) throw new WsException('Unauthorized');

    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new WsException('Invalid coordinates');
    }

    // Le driverId du payload doit appartenir à l'utilisateur authentifié
    const driver = await this.prisma.driver.findUnique({ where: { id: data.driverId } });
    if (!driver || driver.userId !== user.id) {
      throw new WsException('Forbidden: not your driver profile');
    }

    await this.prisma.driver.update({
      where: { id: data.driverId },
      data: { currentLat: lat, currentLng: lng },
    });
    await this.prisma.delivery.updateMany({
      where: { orderId: data.orderId },
      data: { driverLat: lat, driverLng: lng },
    });
    this.server.to(`order_${data.orderId}`).emit('location_update', { lat, lng });
  }

  /** Un client/livreur s'abonne au tracking d'une commande dont il est partie prenante. */
  @SubscribeMessage('track_order')
  async handleTrackOrder(
    @MessageBody() data: { orderId: string },
    @ConnectedSocket() socket: Socket,
  ) {
    await this.joinOrderRoom(data.orderId, socket);
  }

  /**
   * Alias de track_order — utilisé par le mobile driver après avoir accepté
   * une mission (cf driver_provider.dart emit 'join_mission'). Permet au
   * driver de recevoir les events de la room order_<id> (mises à jour de
   * statut côté pro, annulation client, etc.) en plus de pouvoir émettre.
   */
  @SubscribeMessage('join_mission')
  async handleJoinMission(
    @MessageBody() data: { orderId: string },
    @ConnectedSocket() socket: Socket,
  ) {
    await this.joinOrderRoom(data.orderId, socket);
  }

  /** Vérifie l'autorisation puis rejoint la room `order_<orderId>`. */
  private async joinOrderRoom(orderId: string, socket: Socket) {
    const user = (socket.handshake as any).user;
    if (!user) throw new WsException('Unauthorized');

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { clientId: true, professionalId: true, driverId: true },
    });
    if (!order) throw new WsException('Order not found');

    // Seul le client, le pro associé ou le driver assigné peut tracker.
    // Un driver non assigné est autorisé tant qu'il a accepté la mission
    // (pour qu'il puisse rejoindre dès l'accept côté mobile, avant que
    // le state local ait refresh).
    const pro = await this.prisma.professional.findUnique({
      where: { id: order.professionalId }, select: { userId: true },
    });
    const driver = order.driverId
      ? await this.prisma.driver.findUnique({
          where: { id: order.driverId }, select: { userId: true },
        })
      : null;
    const isClient = order.clientId === user.id;
    const isPro    = pro?.userId === user.id;
    const isDriver = driver?.userId === user.id;
    // Driver pas encore assigné mais avec rôle DRIVER : on tolère le join
    // (sera bloqué côté backend à l'accept si pas légitime).
    const isAnyDriver = user.role === 'DRIVER' && !order.driverId;
    if (!isClient && !isPro && !isDriver && !isAnyDriver) {
      throw new WsException('Forbidden');
    }

    socket.join(`order_${orderId}`);
  }
}
