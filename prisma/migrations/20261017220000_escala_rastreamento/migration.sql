-- ============================================================
-- Escala + consistência + rastreamento de revendedores
-- ============================================================

-- 1. OrderStatus: remover o legado CREATED (migra para CONFIRMED)
UPDATE "orders" SET "status" = 'CONFIRMED' WHERE "status" = 'CREATED';
UPDATE "order_timelines" SET "status" = 'CONFIRMED' WHERE "status" = 'CREATED';

ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED', 'IN_DELIVERY', 'DELIVERED', 'CANCELLED');
ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus" USING ("status"::text::"OrderStatus");
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'PENDING_CONFIRMATION';
ALTER TABLE "order_timelines" ALTER COLUMN "status" TYPE "OrderStatus" USING ("status"::text::"OrderStatus");
DROP TYPE "OrderStatus_old";

-- 2. Dinheiro: Float -> Decimal
ALTER TABLE "supplier_products" ALTER COLUMN "default_price" TYPE DECIMAL(10,2) USING ROUND("default_price"::numeric, 2);
ALTER TABLE "supplier_proposals" ALTER COLUMN "freight_price" TYPE DECIMAL(10,2) USING ROUND("freight_price"::numeric, 2);
ALTER TABLE "supplier_proposals" ALTER COLUMN "freight_price" SET DEFAULT 0;
ALTER TABLE "supplier_proposal_items" ALTER COLUMN "unit_price" TYPE DECIMAL(10,2) USING ROUND("unit_price"::numeric, 2);
ALTER TABLE "orders" ALTER COLUMN "total_price" TYPE DECIMAL(10,2) USING ROUND("total_price"::numeric, 2);
ALTER TABLE "credit_wallets" ALTER COLUMN "balance" TYPE DECIMAL(12,2) USING ROUND("balance"::numeric, 2);
ALTER TABLE "credit_wallets" ALTER COLUMN "balance" SET DEFAULT 0;

-- 3. Forma de pagamento como coluna
CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'CASH', 'CREDIT', 'DEBIT', 'BOLETO');
ALTER TABLE "buyer_requests" ADD COLUMN "payment_method" "PaymentMethod";
UPDATE "buyer_requests" SET "payment_method" = CASE
  WHEN "observations" ~* 'Pagamento:\s*Pix' THEN 'PIX'::"PaymentMethod"
  WHEN "observations" ~* 'Pagamento:\s*Dinheiro' THEN 'CASH'::"PaymentMethod"
  WHEN "observations" ~* 'Pagamento:\s*Cr[eé]dito' THEN 'CREDIT'::"PaymentMethod"
  WHEN "observations" ~* 'Pagamento:\s*D[eé]bito' THEN 'DEBIT'::"PaymentMethod"
  ELSE NULL END;

-- 4. Companies: média de avaliação + permissão de rastreamento
ALTER TABLE "companies" ADD COLUMN "rating_avg" DOUBLE PRECISION;
ALTER TABLE "companies" ADD COLUMN "rating_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "companies" ADD COLUMN "tracking_enabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "companies" c SET
  "rating_avg" = r.avg, "rating_count" = r.cnt
FROM (SELECT "supplier_company_id", ROUND(AVG("stars")::numeric, 1)::float8 AS avg, COUNT(*)::int AS cnt
      FROM "supplier_ratings" GROUP BY "supplier_company_id") r
WHERE c."id" = r."supplier_company_id";

-- 5. Posição ao vivo
CREATE TABLE "supplier_live_locations" (
  "company_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "latitude" DOUBLE PRECISION NOT NULL,
  "longitude" DOUBLE PRECISION NOT NULL,
  "heading" DOUBLE PRECISION,
  "speed" DOUBLE PRECISION,
  "is_online" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_live_locations_pkey" PRIMARY KEY ("company_id")
);
ALTER TABLE "supplier_live_locations" ADD CONSTRAINT "supplier_live_locations_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "supplier_live_locations_is_online_updated_at_idx" ON "supplier_live_locations"("is_online", "updated_at");

-- 6. Índices
CREATE INDEX IF NOT EXISTS "users_company_id_idx" ON "users"("company_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "addresses_company_id_idx" ON "addresses"("company_id");
CREATE INDEX IF NOT EXISTS "addresses_city_state_idx" ON "addresses"("city", "state");
CREATE INDEX IF NOT EXISTS "buyer_requests_buyer_company_id_status_idx" ON "buyer_requests"("buyer_company_id", "status");
CREATE INDEX IF NOT EXISTS "buyer_requests_status_expires_at_idx" ON "buyer_requests"("status", "expires_at");
CREATE INDEX IF NOT EXISTS "buyer_request_items_buyer_request_id_idx" ON "buyer_request_items"("buyer_request_id");
CREATE INDEX IF NOT EXISTS "supplier_coverages_city_state_idx" ON "supplier_coverages"("city", "state");
CREATE INDEX IF NOT EXISTS "supplier_coverages_supplier_company_id_idx" ON "supplier_coverages"("supplier_company_id");
CREATE INDEX IF NOT EXISTS "supplier_proposals_supplier_company_id_status_idx" ON "supplier_proposals"("supplier_company_id", "status");
CREATE INDEX IF NOT EXISTS "supplier_proposal_items_supplier_proposal_id_idx" ON "supplier_proposal_items"("supplier_proposal_id");
CREATE INDEX IF NOT EXISTS "orders_buyer_company_id_status_idx" ON "orders"("buyer_company_id", "status");
CREATE INDEX IF NOT EXISTS "orders_supplier_company_id_status_idx" ON "orders"("supplier_company_id", "status");
CREATE INDEX IF NOT EXISTS "orders_status_created_at_idx" ON "orders"("status", "created_at");
CREATE INDEX IF NOT EXISTS "order_timelines_order_id_created_at_idx" ON "order_timelines"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "order_messages_order_id_created_at_idx" ON "order_messages"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "supplier_ratings_supplier_company_id_idx" ON "supplier_ratings"("supplier_company_id");
CREATE INDEX IF NOT EXISTS "push_tokens_user_id_active_idx" ON "push_tokens"("user_id", "active");

-- Limpeza de legado antes do índice único: o sistema antigo nunca expirava cotações
UPDATE "buyer_requests" SET "status" = 'EXPIRED'
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW') AND "expires_at" < NOW();
-- Se ainda houver mais de uma ativa por comprador, mantém só a mais recente
UPDATE "buyer_requests" SET "status" = 'CANCELLED'
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW') AND "id" NOT IN (
    SELECT DISTINCT ON ("buyer_company_id") "id" FROM "buyer_requests"
    WHERE "status" IN ('OPEN', 'UNDER_REVIEW')
    ORDER BY "buyer_company_id", "created_at" DESC
  );

-- Garante no banco no máximo 1 cotação ativa por comprador (evita corrida em criações simultâneas)
CREATE UNIQUE INDEX IF NOT EXISTS "buyer_requests_one_active_per_buyer"
  ON "buyer_requests"("buyer_company_id")
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW');
