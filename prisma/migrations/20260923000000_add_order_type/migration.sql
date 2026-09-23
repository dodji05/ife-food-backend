-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('DELIVERY', 'PICKUP', 'DINE_IN');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "orderType" "OrderType" NOT NULL DEFAULT 'DELIVERY';
