import { IsString, IsOptional, IsEmail, IsIn } from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  // Assigné après upload via /uploads/avatar. Sans ce décorateur, le
  // ValidationPipe whitelist:true le strippait silencieusement.
  @ApiPropertyOptional() @IsOptional() @IsString() avatarUrl?: string;
  // Permet au bottom sheet 'Langue' (utilisé par pro/client/driver) de
  // PATCH /users/me {lang:'xx'} sans passer par l'endpoint dédié /lang.
  @ApiPropertyOptional() @IsOptional() @IsIn(['fr','en','es','de','ru','ar','zh'])
  lang?: string;
}

export class UpdateLangDto {
  @ApiProperty({ enum: ['fr','en','es','de','ru','ar','zh'] })
  @IsIn(['fr','en','es','de','ru','ar','zh']) lang: string;
}

export class UpdateCountryDto {
  @ApiProperty({ example: 'BJ' }) @IsString() countryCode: string;
  @ApiProperty({ example: 'XOF' }) @IsString() currency: string;
}

export class UpdateFcmTokenDto {
  @ApiProperty() @IsString() fcmToken: string;
}

export class AcceptLegalDto {
  @ApiProperty() @IsString() documentType: string;
  @ApiProperty() @IsString() version: string;
}

export class AddAddressDto {
  @ApiProperty() @IsString() label: string;
  @ApiProperty() @IsString() address: string;
  @ApiProperty() lat: number;
  @ApiProperty() lng: number;
}
