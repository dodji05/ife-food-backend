import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, CreateCategoryDto, UpdateCategoryDto, ReorderCategoriesDto, GetProductsQueryDto } from './dto/product.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Post('categories')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.productsService.createCategory(dto);
  }

  @Get('categories/all')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get all global categories (for product creation picker)' })
  getAllCategories() {
    return this.productsService.getAllCategories();
  }

  @Get('categories/mine')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get categories that have products for this professional' })
  getMineCategories(@CurrentUser() user: any) {
    return this.productsService.getCategoriesMine(user.id);
  }

  @Get('categories/:professionalId')
  @Public()
  getCategories(@Param('professionalId') professionalId: string) {
    return this.productsService.getCategories(professionalId);
  }

  // Reorder DOIT être déclaré AVANT `categories/:id` sinon NestJS route
  // 'reorder' vers le param :id (string "reorder") -> 404 cascade.
  @Patch('categories/reorder')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Bulk reorder categories' })
  reorderCategories(@Body() dto: ReorderCategoriesDto) {
    return this.productsService.reorderCategories(dto);
  }

  @Patch('categories/:id')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.productsService.updateCategory(id, dto);
  }

  @Delete('categories/:id')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Delete category (products are decategorized, not deleted)' })
  deleteCategory(@Param('id') id: string) {
    return this.productsService.deleteCategory(id);
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

  @Post(':id/image')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload product image (multipart field name: image)' })
  // Le mobile envoie le fichier sous le champ `image` (FormData).
  // memoryStorage : le buffer est passé directement à Cloudinary, pas de
  // fichier temporaire sur disque (cohérent avec /uploads/avatar).
  @UseInterceptors(FileInterceptor('image', { storage: memoryStorage() }))
  uploadImage(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.productsService.uploadImage(user.id, id, file);
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

  @Get('mine')
  @UseGuards(JwtAuthGuard) @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get my products (professional shortcut)' })
  getMineProducts(@CurrentUser() user: any, @Query() pagination: PaginationDto) {
    return this.productsService.getProductsMine(user.id, pagination);
  }

  @Get('professional/:id')
  @Public()
  getByProfessional(@Param('id') id: string, @Query() query: GetProductsQueryDto) {
    return this.productsService.getProducts(id, query);
  }
}
