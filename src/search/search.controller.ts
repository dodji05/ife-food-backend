import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * GET /search/suggest?q=<text>&country=BJ&limit=5
   *
   * Autocomplete unifié pour l'écran de recherche client : retourne en
   * une seule requête HTTP les top-5 établissements, produits et catégories
   * matchant `q` (case-insensitive, multilingue fr/en).
   *
   * Public — aucune auth requise.
   */
  @Get('suggest')
  @Public()
  @ApiOperation({ summary: 'Suggestions autocomplete (établissements, produits, catégories)' })
  @ApiQuery({ name: 'q',       required: true,  description: 'Texte à rechercher (≥ 1 char)' })
  @ApiQuery({ name: 'country', required: false, description: 'Code pays ISO (BJ, NG, …)' })
  @ApiQuery({ name: 'limit',   required: false, description: 'Max résultats par type (1-10, défaut 5)' })
  suggest(
    @Query('q')       q: string,
    @Query('country') country?: string,
    @Query('limit')   limit?: string,
  ) {
    return this.search.suggest(q, {
      country,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /**
   * GET /search/trending?country=BJ
   *
   * Données pour le panneau "Idées de recherche" affiché avant que
   * l'utilisateur ait commencé à taper. Retourne :
   *   • catégories les plus utilisées (par nombre de produits publiés)
   *   • établissements populaires (par note moyenne)
   *
   * Public, sans auth.
   */
  @Get('trending')
  @Public()
  @ApiOperation({ summary: 'Idées de recherche / tendances depuis la BDD' })
  @ApiQuery({ name: 'country', required: false })
  trending(@Query('country') country?: string) {
    return this.search.trending({ country });
  }
}
