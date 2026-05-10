import { IsString, IsArray, IsNumber, IsOptional, IsIn, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OrderItemDto {
  @ApiProperty() @IsString() productId: string;
  @ApiProperty() @IsNumber() @Min(1) quantity: number;
  @ApiPropertyOptional() @IsOptional() options?: any;
}

export class CreateOrderDto {
  @ApiProperty() @IsString() professionalId: string;
  @ApiProperty({ type: [OrderItemDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto) items: OrderItemDto[];
  @ApiProperty() @IsString() deliveryAddress: string;
  @ApiProperty() @IsNumber() deliveryLat: number;
  @ApiProperty() @IsNumber() deliveryLng: number;
  @ApiPropertyOptional() @IsOptional() @IsString() deliveryCity?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() deliveryCountry?: string;
  @ApiProperty() @IsString() currency: string;
  @ApiProperty() @IsIn(['STRIPE','PAYPAL','KKIAPAY','FEDAPAY','OTHER']) paymentMethod: string;
  @ApiPropertyOptional() @IsOptional() @IsString() promoCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() specialInstructions?: string;
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: ['ACCEPTED','REJECTED','IN_PREPARATION','READY_FOR_PICKUP','DRIVER_ASSIGNED','PICKED_UP','IN_DELIVERY','CANCELLED','DELIVERED'] })
  @IsIn(['ACCEPTED','REJECTED','IN_PREPARATION','READY_FOR_PICKUP','DRIVER_ASSIGNED','PICKED_UP','IN_DELIVERY','CANCELLED','DELIVERED'])
  status: string;
  @ApiPropertyOptional() @IsOptional() @IsString() rejectedReason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cancelledReason?: string;
}
