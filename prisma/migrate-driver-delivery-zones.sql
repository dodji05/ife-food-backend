-- Migration : Zones livreur → sélection depuis les zones admin
-- Remplace la table driver_zones (zones créées par le livreur lui-même)
-- par une table de jointure driver_delivery_zones (livreur choisit parmi
-- les DeliveryZone créées par l'admin).

DROP TABLE IF EXISTS "driver_zones";

CREATE TABLE IF NOT EXISTS "driver_delivery_zones" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  "driverId"       TEXT        NOT NULL,
  "deliveryZoneId" TEXT        NOT NULL,
  "createdAt"      TIMESTAMP   NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  UNIQUE ("driverId", "deliveryZoneId"),
  FOREIGN KEY ("driverId")       REFERENCES "drivers"("id")        ON DELETE CASCADE,
  FOREIGN KEY ("deliveryZoneId") REFERENCES "delivery_zones"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "driver_delivery_zones_driverId_idx"
  ON "driver_delivery_zones"("driverId");
