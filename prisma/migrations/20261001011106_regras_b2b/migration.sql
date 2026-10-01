-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_CONFIRMATION';

-- CreateEnum
CREATE TYPE "AutoAcceptMode" AS ENUM ('NONE', 'PRICE', 'TIME', 'RATING');

-- AlterTable
ALTER TABLE "buyer_requests" ADD COLUMN IF NOT EXISTS "auto_accept_mode" "AutoAcceptMode" NOT NULL DEFAULT 'NONE';
ALTER TABLE "buyer_requests" ADD COLUMN IF NOT EXISTS "counter_offer_rounds" INTEGER NOT NULL DEFAULT 0;
