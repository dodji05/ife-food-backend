import { IsString, IsOptional, IsNumber, IsBoolean, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ⚠️ main.ts : ValidationPipe({whitelist:true, forbidNonWhitelisted:true}).
// Tout champ sans décorateur class-validator est rejeté avec
// 'property X should not exist'.

export class CreateUserAddressDto {
  @ApiProperty({ example: 'Maison' }) @IsString() @IsNotEmpty() label: string;
  @ApiProperty({ example: 'Carré 1234, Cotonou' }) @IsString() @IsNotEmpty() address: string;
  @ApiProperty({ example: 'Cotonou' }) @IsString() @IsNotEmpty() city: string;
  @ApiPropertyOptional({ example: 'BJ', default: 'BJ' }) @IsOptional() @IsString() country?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional({ example: 'Sonner 2x, code 1234' }) @IsOptional() @IsString() instructions?: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateUserAddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() label?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() instructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}
