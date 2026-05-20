import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_LEVEL_KEY } from '../decorators/admin-level.decorator';

@Injectable()
export class AdminLevelGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredLevels = this.reflector.getAllAndOverride<string[]>(ADMIN_LEVEL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredLevels || requiredLevels.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    const level: string = user?.admin?.level;

    if (!level || !requiredLevels.includes(level)) {
      throw new ForbiddenException('Niveau admin insuffisant');
    }
    return true;
  }
}
