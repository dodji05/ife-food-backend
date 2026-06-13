import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeIsOpen } from '../common/utils/opening-hours.util';

/**
 * Recherche unifiée pour le client mobile.
 *
 * Toutes les requêtes passent par `$queryRawUnsafe(sql, ...params)` :
 *   • ILIKE PostgreSQL natif → case-insensitive sur string ET sur JSON path
 *     (`name->>'fr'`), ce que `prisma.findMany` ne propose pas pour les JSON.
 *   • Paramétrage `$1, $2, ...` → zéro injection.
 *   • Trois `try/catch` indépendants : si une requête échoue, les deux
 *     autres restent disponibles (avant ça donnait "tout vide" sans
 *     visibilité sur la cause).
 *   • `LIMIT ${limit}` interpolé inline (sûr car borné dans [1,10]) pour
 *     éviter les conflits de numérotation $N avec les filtres optionnels
 *     (country).
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  constructor(private prisma: PrismaService) {}

  // ── Autocomplete principale ────────────────────────────────────────────────
  async suggest(query: string, opts: { country?: string; limit?: number } = {}) {
    const q = (query ?? '').trim();
    if (q.length < 1) {
      return { data: { establishments: [], products: [], categories: [] } };
    }
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    const like  = `%${q}%`;
    const prefix = `${q}%`;
    const country = opts.country?.trim();

    // Les 3 requêtes sont isolées dans des try/catch séparés pour qu'un
    // souci sur une seule n'éteigne pas les deux autres (sinon on revient
    // au symptôme "tout vide" sans visibilité).
    let establishments: any[] = [];
    let products: any[]       = [];
    let categories: any[]     = [];

    // ── Établissements ────────────────────────────────────────────────────────
    try {
      establishments = await this.prisma.$queryRawUnsafe<any[]>(
        `
        SELECT id, "businessName", category::text AS category,
               "logoUrl", "coverImageUrl", city, "isOpen", country
        FROM "professionals"
        WHERE status = 'VALIDATED'
          ${country ? 'AND country = $3' : ''}
          AND (
            "businessName" ILIKE $1
            OR COALESCE(description, '') ILIKE $1
            OR COALESCE(city, '')        ILIKE $1
            OR CAST(category AS TEXT)    ILIKE $1
          )
        ORDER BY
          CASE
            WHEN "businessName" ILIKE $2 THEN 0
            ELSE 1
          END,
          "businessName" ASC
        LIMIT ${limit}
        `,
        like, prefix, ...(country ? [country] : []),
      );
    } catch (e: any) {
      this.logger.error(`suggest establishments q="${q}" failed: ${e?.message}`);
    }

    // ── Produits ──────────────────────────────────────────────────────────────
    try {
      products = await this.prisma.$queryRawUnsafe<any[]>(
        `
        SELECT p.id, p.name, p.description, p.price, p.currency,
               p."imageUrl", p."categoryId", p."professionalId",
               prof."businessName" AS "professionalName",
               prof."logoUrl"      AS "professionalLogoUrl",
               prof."isOpen"       AS "professionalIsOpen"
        FROM "products" p
        JOIN "professionals" prof ON prof.id = p."professionalId"
        WHERE p."isAvailable" = true
          AND prof.status     = 'VALIDATED'
          ${country ? 'AND prof.country = $3' : ''}
          AND (
            COALESCE(p.name->>'fr', '')        ILIKE $1
            OR COALESCE(p.name->>'en', '')     ILIKE $1
            OR COALESCE(p.description->>'fr', '') ILIKE $1
            OR COALESCE(p.description->>'en', '') ILIKE $1
          )
        ORDER BY
          CASE
            WHEN COALESCE(p.name->>'fr', '') ILIKE $2 THEN 0
            WHEN COALESCE(p.name->>'en', '') ILIKE $2 THEN 0
            ELSE 1
          END,
          p.name->>'fr' ASC
        LIMIT ${limit}
        `,
        like, prefix, ...(country ? [country] : []),
      );
    } catch (e: any) {
      this.logger.error(`suggest products q="${q}" failed: ${e?.message}`);
    }

    // ── Catégories ────────────────────────────────────────────────────────────
    try {
      // Pas de DISTINCT ici : c.id est déjà unique (PK). Avec DISTINCT,
      // Postgres refuse `ORDER BY c.name->>'fr'` si l'expression n'apparait
      // pas dans la liste DISTINCT → erreur silencieuse côté catch.
      categories = await this.prisma.$queryRawUnsafe<any[]>(
        `
        SELECT c.id, c.name, c.icon
        FROM "product_categories" c
        WHERE COALESCE(c.name->>'fr', '') ILIKE $1
           OR COALESCE(c.name->>'en', '') ILIKE $1
        ORDER BY c.name->>'fr' ASC
        LIMIT ${limit}
        `,
        like,
      );
    } catch (e: any) {
      this.logger.error(`suggest categories q="${q}" failed: ${e?.message}`);
    }

    this.logger.log(
      `suggest q="${q}" → ${establishments.length} pros, ${products.length} produits, ${categories.length} catégories`,
    );

    return { data: { establishments, products, categories } };
  }

  // ── Tendances / idées de recherche depuis la BDD ───────────────────────────
  /**
   * Sert à peupler le panneau "Idées de recherche" affiché AVANT que
   * l'utilisateur ait tapé quoi que ce soit. Plus de chips statiques
   * en dur dans le mobile — tout vient de la BDD.
   *
   * Composition :
   *  • Top 8 catégories de produits par fréquence d'utilisation (les
   *    catégories qui ont le plus de produits réellement publiés).
   *  • Top 6 établissements validés, triés par note moyenne décroissante
   *    puis par récence.
   */
  async trending(opts: { country?: string } = {}) {
    const country = opts.country?.trim();

    try {
      // Catégories les plus utilisées (parmi celles qui ont >= 1 produit)
      const categories = await this.prisma.$queryRawUnsafe<any[]>(
        `
        SELECT c.id, c.name, c.icon, COUNT(p.id)::int AS "productCount"
        FROM "product_categories" c
        JOIN "products" p ON p."categoryId" = c.id AND p."isAvailable" = true
        JOIN "professionals" prof ON prof.id = p."professionalId"
          AND prof.status = 'VALIDATED'
          ${country ? `AND prof.country = $1` : ''}
        GROUP BY c.id, c.name, c.icon
        HAVING COUNT(p.id) > 0
        ORDER BY COUNT(p.id) DESC
        LIMIT 8
        `,
        ...(country ? [country] : []),
      );

      // Établissements populaires (par note moyenne)
      const ratingAgg = await this.prisma.review.groupBy({
        by: ['professionalId'],
        _avg: { professionalRating: true },
        _count: true,
        where: { professionalId: { not: null } },
      });
      // Map proId → {avg, count}
      const ratingMap = new Map<string, { avg: number; count: number }>();
      for (const r of ratingAgg) {
        if (r.professionalId) {
          ratingMap.set(r.professionalId, {
            avg:   r._avg.professionalRating ?? 0,
            count: r._count,
          });
        }
      }

      const proCandidates = await this.prisma.professional.findMany({
        where: { status: 'VALIDATED', ...(country ? { country } : {}) },
        select: {
          id: true, businessName: true, category: true,
          logoUrl: true, coverImageUrl: true, city: true, isOpen: true,
          openingHours: true,
          createdAt: true,
        },
        take: 30, // on overfetch puis on trie + slice
        orderBy: { createdAt: 'desc' },
      });
      const establishments = proCandidates
        .map((p) => ({ ...p, _rating: ratingMap.get(p.id) ?? { avg: 0, count: 0 } }))
        .sort((a, b) => {
          if (b._rating.avg !== a._rating.avg) return b._rating.avg - a._rating.avg;
          return b._rating.count - a._rating.count;
        })
        .slice(0, 6)
        .map(({ _rating, ...p }) => ({
          ...p,
          isOpen:      computeIsOpen(p.isOpen, p.openingHours),
          avgRating:   _rating.avg,
          reviewCount: _rating.count,
        }));

      this.logger.log(
        `trending → ${categories.length} catégories, ${establishments.length} pros`,
      );

      return { data: { categories, establishments } };
    } catch (e: any) {
      this.logger.error(`trending failed: ${e?.message}`, e?.stack);
      return { data: { categories: [], establishments: [] } };
    }
  }
}
