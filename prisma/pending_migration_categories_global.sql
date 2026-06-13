-- Migration : Dissociation catégories / professionnels
-- Les catégories de produits deviennent globales (indépendantes d'un professionnel).
-- On supprime la colonne professionalId et sa contrainte FK de la table product_categories.

ALTER TABLE "product_categories" DROP CONSTRAINT IF EXISTS "product_categories_professionalId_fkey";
DROP INDEX IF EXISTS "product_categories_professionalId_idx";
ALTER TABLE "product_categories" DROP COLUMN IF EXISTS "professionalId";
