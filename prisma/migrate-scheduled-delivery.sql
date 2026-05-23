-- Migration : Livraison planifiée
-- À exécuter sur le VPS : psql $DATABASE_URL -f prisma/migrate-scheduled-delivery.sql
-- OU via Prisma sur le VPS : npx prisma db push (lit le schema.prisma mis à jour)

ALTER TABLE "orders"
ADD COLUMN IF NOT EXISTS "scheduledDeliveryAt" TIMESTAMP(3);
