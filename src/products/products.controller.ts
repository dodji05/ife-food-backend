import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, CreateCategoryDto } from './dto/product.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Post('categories')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  createCategory(@CurrentUser() user: any, @Body() dto: CreateCategoryDto) {
    return this.productsService.createCategory(user.id, dto);
  }

  @Get('categories/:professionalId')
  @Public()
  getCategories(@Param('professionalId') professionalId: string) {
    return this.productsService.getCategories(professionalId);
  }

  @Post()
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Create a product' })
  create(@CurrentUser() user: any, @Body() dto: CreateProductDto) {
    return this.productsService.createProduct(user.id, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: UpdateProductDto) {
    return this.productsService.updateProduct(user.id, id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  delete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.productsService.deleteProduct(user.id, id);
  }

  @Patch(':id/toggle')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Toggle product availability' })
  toggle(@Param('id') id: string, @CurrentUser() user: any) {
    return this.productsService.toggleAvailability(user.id, id);
  }

  @Get('search')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  search(
    @Query('q') q: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ) {
    return this.productsService.searchProducts(
      q,
      lat !== undefined ? parseFloat(lat) : undefined,
      lng !== undefined ? parseFloat(lng) : undefined,
    );
  }

  @Get('professional/:id')
  @Public()
  getByProfessional(@Param('id') id: string, @Query() pagination: PaginationDto) {
    return this.productsService.getProducts(id, pagination);
  }
}
