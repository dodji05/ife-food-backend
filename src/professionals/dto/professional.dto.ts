import { IsString, IsNotEmpty, IsNumber, IsOptional, IsIn, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProfessionalDto {
  @ApiProperty() @IsString() businessName: string;
  @ApiProperty({ enum: ['RESTAURANT','GROCERY','SUPERMARKET','BAKERY','PHARMACY','OTHER'] })
  @IsIn(['RESTAURANT','GROCERY','SUPERMARKET','BAKERY','PHARMACY','OTHER']) category: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty() @IsString() address: string;
  @ApiProperty() @IsString() city: string;
  @ApiProperty() @IsString() country: string;
  @ApiProperty() @IsNumber() lat: number;
  @ApiProperty() @IsNumber() lng: number;
  @ApiPropertyOptional() @IsOptional() @IsString() rccm?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() email?: string;
}

export class UpdateProfessionalDto {
  @ApiPropertyOptional() @IsOptional() @IsString() businessName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() deliveryRadiusKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() email?: string;
  // Whitelist URLs assignées après upload via /uploads/avatar.
  // Sans ces décorateurs, ValidationPipe(whitelist:true) les strippait
  // silencieusement -> le PATCH logo/cover était un no-op pour le mobile.
  @ApiPropertyOptional() @IsOptional() @IsString() logoUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() coverImageUrl?: string;
}

export class UpdateOpeningHoursDto {
  // @IsObject() obligatoire sinon ValidationPipe whitelist:true le strip
  // silencieusement -> dto.openingHours = undefined -> Prisma update no-op.
  @ApiProperty({ description: '{ mon: { open: "08:00", close: "22:00" }, ... }' })
  @IsObject() openingHours: any;
}
