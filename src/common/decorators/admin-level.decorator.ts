import { SetMetadata } from '@nestjs/common';

export const ADMIN_LEVEL_KEY = 'adminLevel';
export const AdminLevel = (...levels: string[]) =>
  SetMetadata(ADMIN_LEVEL_KEY, levels);
