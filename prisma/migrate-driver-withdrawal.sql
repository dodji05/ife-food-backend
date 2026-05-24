-- Migration : Demande de virement livreur
-- Ajoute la valeur WITHDRAWAL à l'enum TransactionType pour matérialiser
-- les demandes de virement soumises par le livreur depuis l'app.
-- Un statut PENDING = en attente de traitement admin ; COMPLETED = versé.

ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL';
