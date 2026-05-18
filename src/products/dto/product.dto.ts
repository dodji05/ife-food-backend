import { IsString, IsNumber, IsOptional, IsBoolean, IsObject, IsNotEmptyObject, IsArray, ArrayNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ⚠️ main.ts : ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }).
// Tout champ SANS décorateur class-validator est rejeté avec
// 'property X should not exist'. Pour les Map multilingues (name,
// description, variants) on utilise @IsObject() pour les whitelister.

export class CreateCategoryDto {
  @ApiProperty({ description: 'Multilingual name: { fr: "Plats", en: "Dishes" }' })
  @IsNotEmptyObject() name: any;
  @ApiPropertyOptional() @IsOptional() @IsString() icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional() @IsOptional() @IsObject() name?: any;
  @ApiPropertyOptional() @IsOptional() @IsString() icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() sortOrder?: number;
}

// Bulk reorder : [{id, sortOrder}, ...]. Le service applique chaque update
// dans une transaction Prisma. Tableau requis non vide.
export class ReorderCategoriesDto {
  @ApiProperty({ description: '[{id: "...", sortOrder: 0}, ...]' })
  @IsArray() @ArrayNotEmpty()
  items: { id: string; sortOrder: number }[];
}

export class CreateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsString() categoryId?: string;
  @ApiProperty({ description: 'Multilingual: { fr: "...", en: "..." }' })
  @IsNotEmptyObject() name: any;
  @ApiPropertyOptional() @IsOptional() @IsObject() description?: any;
  @ApiProperty() @IsNumber() price: number;
  @ApiProperty() @IsString() currency: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  // isAvailable manquait au create -> le mobile l'envoie en POST -> rejet.
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() stock?: number;
  @ApiPropertyOptional() @IsOptional() @IsObject() variants?: any;
}

export class UpdateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsObject() name?: any;
  @ApiPropertyOptional() @IsOptional() @IsObject() description?: any;
  @ApiPropertyOptional() @IsOptional() @IsString() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() price?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() stock?: number;
  @ApiPropertyOptional() @IsOptional() @IsObject() variants?: any;
}
