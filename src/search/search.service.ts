import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

/**
 * Recherche unifiée pour le client mobile : suggestions en temps réel
 * (autocomplete) sur 3 types d'entités — établissements, produits et
 * catégories de produits.
 *
 * Pourquoi du raw SQL plutôt que `prisma.findMany` ?
 *   1. Les champs `name` / `description` sont des Json multilingues
 *      ({fr, en, ...}). Prisma supporte `path: ['fr'], string_contains: q`
 *      mais c'est **case-sensitive** sur PostgreSQL : "Pizza" ne matcherait
 *      pas "pizza". `ILIKE` côté SQL natif fait le match insensitive d'un
 *      coup, sur fr ET en, sans normalisation côté Node.
 *   2. La pagination/LIMIT par section reste contrôlée.
 *
 * Sécurité : `query` est interpolé via tag template Prisma (`${like}`),
 * paramétrisé → aucune injection SQL possible.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  constructor(private prisma: PrismaService) {}

  async suggest(query: string, opts: { country?: string; limit?: number } = {}) {
    const q = (query ?? '').trim();
    if (q.length < 1) {
      return { data: { establishments: [], products: [], categories: [] } };
    }
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    const like  = `%${q}%`;
    const country = opts.country?.trim();

    // Note : `Prisma.sql` permet de composer des conditions optionnelles
    // sans casser le paramétrage.
    const proCountryFilter = country
      ? Prisma.sql`AND country = ${country}`
      : Prisma.empty;

    try {
      const [establishments, products, categories] = await Promise.all([
        this.prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT id, "businessName", category::text AS category, "logoUrl",
                 "coverImageUrl", city, "isOpen", country
          FROM "professionals"
          WHERE status = 'VALIDATED'
            ${proCountryFilter}
            AND (
              "businessName" ILIKE ${like}
              OR description ILIKE ${like}
              OR city        ILIKE ${like}
              OR CAST(category AS TEXT) ILIKE ${like}
            )
          ORDER BY
            -- Match exact / au début > match contenu
            CASE
              WHEN "businessName" ILIKE ${q}      THEN 0
              WHEN "businessName" ILIKE ${q + '%'} THEN 1
              ELSE 2
            END,
            "businessName" ASC
          LIMIT ${limit}
        `),
        this.prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT p.id, p.name, p.description, p.price, p.currency,
                 p."imageUrl", p."categoryId", p."professionalId",
                 prof."businessName" AS "professionalName",
                 prof."logoUrl"      AS "professionalLogoUrl",
                 prof."isOpen"       AS "professionalIsOpen"
          FROM "products" p
          JOIN "professionals" prof ON prof.id = p."professionalId"
          WHERE p."isAvailable" = true
            AND prof.status     = 'VALIDATED'
            ${country ? Prisma.sql`AND prof.country = ${country}` : Prisma.empty}
            AND (
              p.name->>'fr'        ILIKE ${like}
              OR p.name->>'en'     ILIKE ${like}
              OR p.description->>'fr' ILIKE ${like}
              OR p.description->>'en' ILIKE ${like}
            )
          ORDER BY
            CASE
              WHEN p.name->>'fr' ILIKE ${q + '%'} THEN 0
              WHEN p.name->>'en' ILIKE ${q + '%'} THEN 0
              ELSE 1
            END,
            p.name->>'fr' ASC
          LIMIT ${limit}
        `),
        this.prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT DISTINCT c.id, c.name, c.icon
          FROM "product_categories" c
          WHERE c.name->>'fr' ILIKE ${like}
             OR c.name->>'en' ILIKE ${like}
          ORDER BY c.name->>'fr' ASC
          LIMIT ${limit}
        `),
      ]);

      this.logger.debug(
        `suggest q="${q}" → ${establishments.length} pros, ` +
        `${products.length} produits, ${categories.length} catégories`,
      );

      return {
        data: {
          establishments,
          products,
          categories,
        },
      };
    } catch (e: any) {
      this.logger.error(`suggest q="${q}" failed: ${e?.message}`);
      // On ne propage pas l'erreur — autocomplete doit être tolérant.
      return { data: { establishments: [], products: [], categories: [] } };
    }
  }
}
