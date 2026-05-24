-- Migration : Code de confirmation de livraison
-- Ajoute deliveryCode sur la table orders.
-- Le code est généré côté applicatif à la création de la commande ;
-- il est communiqué au client via FCM et visible dans son écran de suivi.
-- Le livreur doit le saisir pour confirmer la livraison (si PlatformConfig
-- key='delivery_confirm_code' → { enabled: true, digits: 4 }).

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "deliveryCode" TEXT;

-- Génère un code aléatoire 4 chiffres pour les commandes PAID déjà en cours
-- qui n'en ont pas encore (migration de l'existant).
UPDATE "orders"
  SET "deliveryCode" = LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0')
  WHERE "deliveryCode" IS NULL
    AND "status" NOT IN ('PENDING_PAYMENT', 'CANCELLED', 'REJECTED');
