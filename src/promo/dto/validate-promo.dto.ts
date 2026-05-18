import { IsString, IsNumber, IsOptional, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ⚠️ ValidationPipe whitelist:true strict.
export class ValidatePromoDto {
  @ApiProperty({ example: 'WELCOME10' }) @IsString() @IsNotEmpty() code: string;
  @ApiProperty({ example: 5000, description: 'Sous-total du panier (avant promo)' })
  @IsNumber() subtotal: number;
  @ApiPropertyOptional({ example: 'XOF' }) @IsOptional() @IsString() currency?: string;
}
