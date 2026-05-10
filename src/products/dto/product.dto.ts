import { IsString, IsNumber, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCategoryDto {
  @ApiProperty({ description: 'Multilingual name: { fr: "Plats", en: "Dishes" }' }) name: any;
  @ApiPropertyOptional() @IsOptional() @IsString() icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() sortOrder?: number;
}

export class CreateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsString() categoryId?: string;
  @ApiProperty({ description: 'Multilingual: { fr: "...", en: "..." }' }) name: any;
  @ApiPropertyOptional() @IsOptional() description?: any;
  @ApiProperty() @IsNumber() price: number;
  @ApiProperty() @IsString() currency: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() stock?: number;
  @ApiPropertyOptional() @IsOptional() variants?: any;
}

export class UpdateProductDto {
  @ApiPropertyOptional() name?: any;
  @ApiPropertyOptional() description?: any;
  @ApiPropertyOptional() @IsOptional() @IsNumber() price?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() stock?: number;
}
