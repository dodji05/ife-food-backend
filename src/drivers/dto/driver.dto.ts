import { IsString, IsNumber, IsOptional, IsIn, IsBoolean, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDriverDto {
  @ApiProperty({ enum: ['BICYCLE','MOTORCYCLE','CAR','ON_FOOT'] })
  @IsIn(['BICYCLE','MOTORCYCLE','CAR','ON_FOOT']) vehicleType: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licensePlate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zoneCity?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zoneCountry?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() zoneRadiusKm?: number;
}

export class UpdateDriverDto {
  @ApiPropertyOptional({ enum: ['BICYCLE','MOTORCYCLE','CAR','ON_FOOT'] })
  @IsOptional() @IsIn(['BICYCLE','MOTORCYCLE','CAR','ON_FOOT']) vehicleType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licensePlate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zoneCity?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() zoneRadiusKm?: number;
}

export class UpdateLocationDto {
  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber() @Min(-90) @Max(90) lat: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber() @Min(-180) @Max(180) lng: number;
}

export class CreateDriverZoneDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() city: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() radiusKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateDriverZoneDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() radiusKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}
