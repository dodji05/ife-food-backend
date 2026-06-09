import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

/**
 * Recherche unifiée pour le client mobile.
 *
 * Approche hybride :
 *   • Pour les champs string natifs (businessName, description, city) on
 *     utilise Prisma classique avec `mode: 'insensitive'` — plus lisible,
 *     plus sûr et plus facile à maintenir.
 *   • Pour les champs JSON multilingues (`name` produit/catégorie) on
 *     passe par `$queryRawUnsafe` avec paramètres `$1` numérotés —
 *     `mode: 'insensitive'` ne fonctionne pas avec `path: ['fr'], string_contains`
 *     sur PostgreSQL (Prisma quote la valeur sans appliquer la collation).
 *
 * Les requêtes raw utilisent `$queryRawUnsafe(sql, ...params)` qui paramétrise
 * les arguments → zéro injection. L'usage de `Prisma.sql` tagged template
 * avec interpolation conditionnelle (`Prisma.empty`) que j'avais tenté
 * en V1 retournait silencieusement 0 ligne en prod — la forme `Unsafe + $N`
 * est plus robuste.
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

    try {
      // ── Établissements (Prisma classique) ──────────────────────────────────
      const proWhere: Prisma.ProfessionalWhereInput = {
        status: 'VALIDATED',
        ...(country ? { country } : {}),
        OR: [
          { businessName: { contains: q, mode: 'insensitive' } },
          { description:  { contains: q, mode: 'insensitive' } },
          { city:         { contains: q, mode: 'insensitive' } },
        ],
      };
      const establishments = await this.prisma.professional.findMany({
        where: proWhere,
        select: {
          id: true, businessName: true, category: true,
          logoUrl: true, coverImageUrl: true, city: true,
          isOpen: true, country: true,
        },
        orderBy: { businessName: 'asc' },
        take: limit,
      });

      // ── Produits (raw SQL pour JSON multilingue) ───────────────────────────
      const products = await this.prisma.$queryRawUnsafe<any[]>(
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
          ${country ? 'AND prof.country = $4' : ''}
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
        LIMIT $3
        `,
        like, prefix, limit, ...(country ? [country] : []),
      );

      // ── Catégories (raw SQL) ───────────────────────────────────────────────
      const categories = await this.prisma.$queryRawUnsafe<any[]>(
        `
        SELECT DISTINCT c.id, c.name, c.icon
        FROM "product_categories" c
        WHERE COALESCE(c.name->>'fr', '') ILIKE $1
           OR COALESCE(c.name->>'en', '') ILIKE $1
        ORDER BY c.name->>'fr' ASC
        LIMIT $2
        `,
        like, limit,
      );

      this.logger.log(
        `suggest q="${q}" → ${establishments.length} pros, ${products.length} produits, ${categories.length} catégories`,
      );

      return { data: { establishments, products, categories } };
    } catch (e: any) {
      this.logger.error(`suggest q="${q}" failed: ${e?.message}`, e?.stack);
      return { data: { establishments: [], products: [], categories: [] } };
    }
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
