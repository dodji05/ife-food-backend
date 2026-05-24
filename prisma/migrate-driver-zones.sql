-- Migration : Zones de livraison par livreur
-- Crée la table driver_zones permettant à chaque livreur de définir
-- plusieurs zones d'activité (ville, pays, rayon en km).

CREATE TABLE IF NOT EXISTS "driver_zones" (
  "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "driverId"   TEXT         NOT NULL,
  "name"       TEXT         NOT NULL,
  "city"       TEXT         NOT NULL,
  "country"    TEXT         NOT NULL DEFAULT 'BJ',
  "radiusKm"   DOUBLE PRECISION NOT NULL DEFAULT 10,
  "isDefault"  BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "driver_zones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_zones_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "driver_zones_driverId_idx"
  ON "driver_zones"("driverId");

-- Migration de l'ancienne zone unique (zoneCity / zoneCountry / zoneRadiusKm)
-- vers la nouvelle table pour les livreurs existants qui avaient déjà configuré
-- leur zone. On crée une ligne isDefault=true pour chacun.
INSERT INTO "driver_zones" ("id", "driverId", "name", "city", "country", "radiusKm", "isDefault", "createdAt")
SELECT
  gen_random_uuid()::text,
  d."id",
  COALESCE(d."zoneCity", 'Zone principale'),
  COALESCE(d."zoneCity", 'Cotonou'),
  COALESCE(d."zoneCountry", 'BJ'),
  COALESCE(d."zoneRadiusKm", 10),
  true,
  NOW()
FROM "drivers" d
WHERE d."zoneCity" IS NOT NULL
ON CONFLICT DO NOTHING;
