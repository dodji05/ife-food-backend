-- Migration : Multi-livraison livreur
-- Ajoute maxConcurrentDeliveries sur la table drivers
-- Valeur par défaut 1 → aucune régression sur les livreurs existants

ALTER TABLE "drivers" 
ADD COLUMN IF NOT EXISTS "maxConcurrentDeliveries" INTEGER NOT NULL DEFAULT 1;

-- Commentaire : Pour activer la multi-livraison sur un livreur spécifique,
-- l'admin met à jour ce champ depuis le back-office :
-- UPDATE "drivers" SET "maxConcurrentDeliveries" = 3 WHERE "id" = '...';
