import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';

/**
 * Guard JWT pour WebSocket. Lit le token depuis :
 *   - socket.handshake.auth.token (recommandé : Socket.IO auth payload)
 *   - socket.handshake.headers.authorization ("Bearer xxx")
 * Si valide, attache `socket.handshake.user = { id, role }`.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    return this.authenticate(client);
  }

  /** Peut être appelé directement depuis handleConnection / handleDisconnect. */
  authenticate(client: Socket): boolean {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.disconnect(client, 'Token manquant');
        return false;
      }
      const payload = this.jwtService.verify(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      (client.handshake as any).user = { id: payload.sub, role: payload.role };
      return true;
    } catch (err) {
      this.logger.warn(`WS auth refusée : ${err?.message ?? err}`);
      this.disconnect(client, 'Token invalide');
      return false;
    }
  }

  private extractToken(client: Socket): string | null {
    const fromAuth = (client.handshake.auth as any)?.token as string | undefined;
    if (fromAuth && fromAuth !== 'null' && fromAuth !== 'undefined') {
      return fromAuth.replace(/^Bearer\s+/i, '');
    }
    const header = client.handshake.headers.authorization;
    if (header?.toLowerCase().startsWith('bearer ')) {
      const t = header.slice(7);
      if (t && t !== 'null' && t !== 'undefined') return t;
    }
    return null;
  }

  private disconnect(client: Socket, reason: string) {
    client.emit('error', { message: reason });
    client.disconnect(true);
  }
}
