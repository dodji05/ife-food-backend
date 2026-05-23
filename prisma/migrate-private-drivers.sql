ALTER TABLE "drivers"
  ADD COLUMN IF NOT EXISTS "isPrivate"                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "privateForProfessionalId" TEXT;
