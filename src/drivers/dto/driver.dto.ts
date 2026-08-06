import { IsString, IsNumber, IsOptional, IsIn, IsBoolean, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const VEHICLE_TYPES = ['BICYCLE','MOTORCYCLE','TRICYCLE','CAR','ON_FOOT'];

export class CreateDriverDto {
  @ApiProperty({ enum: VEHICLE_TYPES })
  @IsIn(VEHICLE_TYPES) vehicleType: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licensePlate?: string;
  // Auto-déclaratif — requis en service pour MOTORCYCLE/TRICYCLE/CAR uniquement.
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isInsured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() zoneCity?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zoneCountry?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() zoneRadiusKm?: number;
}

export class UpdateDriverDto {
  @ApiPropertyOptional({ enum: VEHICLE_TYPES })
  @IsOptional() @IsIn(VEHICLE_TYPES) vehicleType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licensePlate?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isInsured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() zoneCity?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() zoneRadiusKm?: number;
}

export class UpdateLocationDto {
  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber() @Min(-90) @Max(90) lat: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber() @Min(-180) @Max(180) lng: number;
}

export class SelectDriverZoneDto {
  @ApiProperty({ description: 'ID of a DeliveryZone created by admin' })
  @IsString() deliveryZoneId: string;
}
