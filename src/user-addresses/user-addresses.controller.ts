import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserAddressesService } from './user-addresses.service';
import { CreateUserAddressDto, UpdateUserAddressDto } from './dto/user-address.dto';

@ApiTags('user-addresses')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('user-addresses')
export class UserAddressesController {
  constructor(private addressesService: UserAddressesService) {}

  @Get()
  @ApiOperation({ summary: 'Liste les adresses du user authentifié' })
  list(@CurrentUser() user: any) {
    return this.addressesService.list(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Crée une adresse (1ère = auto default)' })
  create(@CurrentUser() user: any, @Body() dto: CreateUserAddressDto) {
    return this.addressesService.create(user.id, dto);
  }

  // Route 'default' déclarée AVANT ':id' sinon NestJS route 'default'
  // vers le param :id (-> "Adresse introuvable" cascade).
  @Patch(':id/default')
  @ApiOperation({ summary: 'Marque une adresse comme défaut (désactive les autres)' })
  setDefault(@CurrentUser() user: any, @Param('id') id: string) {
    return this.addressesService.setDefault(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Met à jour une adresse' })
  update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateUserAddressDto) {
    return this.addressesService.update(user.id, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprime une adresse (promote la suivante en default si nécessaire)' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.addressesService.remove(user.id, id);
  }
}
