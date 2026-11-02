-- ============================================================
-- Estruturas que existiam no schema.prisma mas nunca foram
-- versionadas em migration (criadas via `db push` no banco antigo).
-- Idempotente: no banco antigo vira no-op; em banco novo cria tudo.
-- Valores monetários ficam DOUBLE aqui; a migration
-- 20261017220000_escala_rastreamento converte para DECIMAL.
-- ============================================================

-- Enums
DO $$ BEGIN
  CREATE TYPE "BiddingMode" AS ENUM ('AUTO_ONLY', 'MANUAL_ONLY', 'BOTH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "ProposalStatus" ADD VALUE IF NOT EXISTS 'COUNTER_OFFER';

-- supplier_products
CREATE TABLE IF NOT EXISTS "supplier_products" (
    "id" TEXT NOT NULL,
    "supplier_company_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "bidding_mode" "BiddingMode" NOT NULL DEFAULT 'BOTH',
    "default_price" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_products_supplier_company_id_product_id_key"
  ON "supplier_products"("supplier_company_id", "product_id");

-- buyer_request_items (multi-produto)
CREATE TABLE IF NOT EXISTS "buyer_request_items" (
    "id" TEXT NOT NULL,
    "buyer_request_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    CONSTRAINT "buyer_request_items_pkey" PRIMARY KEY ("id")
);

-- Migra produto/quantidade legados de buyer_requests para itens e remove as colunas
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'buyer_requests' AND column_name = 'product_id') THEN
    INSERT INTO "buyer_request_items" ("id", "buyer_request_id", "product_id", "quantity")
      SELECT 'mig_' || "id", "id", "product_id", "quantity" FROM "buyer_requests"
      ON CONFLICT DO NOTHING;
    ALTER TABLE "buyer_requests" DROP CONSTRAINT IF EXISTS "buyer_requests_product_id_fkey";
    ALTER TABLE "buyer_requests" DROP COLUMN "product_id";
    ALTER TABLE "buyer_requests" DROP COLUMN IF EXISTS "quantity";
  END IF;
END $$;

-- supplier_proposal_items
CREATE TABLE IF NOT EXISTS "supplier_proposal_items" (
    "id" TEXT NOT NULL,
    "supplier_proposal_id" TEXT NOT NULL,
    "buyer_request_item_id" TEXT NOT NULL,
    "unit_price" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "supplier_proposal_items_pkey" PRIMARY KEY ("id")
);

-- supplier_proposals: delivery_days/unit_price -> delivery_deadline/payment_terms/itens
ALTER TABLE "supplier_proposals" ADD COLUMN IF NOT EXISTS "payment_terms" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'supplier_proposals' AND column_name = 'delivery_deadline') THEN
    ALTER TABLE "supplier_proposals" ADD COLUMN "delivery_deadline" TIMESTAMP(3);
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'supplier_proposals' AND column_name = 'delivery_days') THEN
      UPDATE "supplier_proposals"
        SET "delivery_deadline" = "created_at" + ("delivery_days" || ' days')::interval;
    END IF;
    UPDATE "supplier_proposals" SET "delivery_deadline" = "created_at" WHERE "delivery_deadline" IS NULL;
    ALTER TABLE "supplier_proposals" ALTER COLUMN "delivery_deadline" SET NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'supplier_proposals' AND column_name = 'unit_price') THEN
    INSERT INTO "supplier_proposal_items" ("id", "supplier_proposal_id", "buyer_request_item_id", "unit_price")
      SELECT 'mig_' || p."id", p."id", i."id", p."unit_price"
      FROM "supplier_proposals" p
      JOIN "buyer_request_items" i ON i."buyer_request_id" = p."buyer_request_id"
      ON CONFLICT DO NOTHING;
    ALTER TABLE "supplier_proposals" DROP COLUMN "unit_price";
  END IF;
END $$;
ALTER TABLE "supplier_proposals" DROP COLUMN IF EXISTS "delivery_days";

-- order_messages
CREATE TABLE IF NOT EXISTS "order_messages" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_messages_pkey" PRIMARY KEY ("id")
);

-- supplier_ratings
CREATE TABLE IF NOT EXISTS "supplier_ratings" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "buyer_company_id" TEXT NOT NULL,
    "supplier_company_id" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "supplier_ratings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_ratings_order_id_key" ON "supplier_ratings"("order_id");

-- system_settings
CREATE TABLE IF NOT EXISTS "system_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_settings_key_key" ON "system_settings"("key");

-- push_tokens
CREATE TABLE IF NOT EXISTS "push_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "push_tokens_token_key" ON "push_tokens"("token");

-- Foreign keys (só cria se ainda não existir)
DO $$
DECLARE fk RECORD;
BEGIN
  FOR fk IN SELECT * FROM (VALUES
    ('supplier_products', 'supplier_products_supplier_company_id_fkey', 'FOREIGN KEY ("supplier_company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
    ('supplier_products', 'supplier_products_product_id_fkey', 'FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
    ('buyer_request_items', 'buyer_request_items_buyer_request_id_fkey', 'FOREIGN KEY ("buyer_request_id") REFERENCES "buyer_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
    ('buyer_request_items', 'buyer_request_items_product_id_fkey', 'FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('supplier_proposal_items', 'supplier_proposal_items_supplier_proposal_id_fkey', 'FOREIGN KEY ("supplier_proposal_id") REFERENCES "supplier_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
    ('supplier_proposal_items', 'supplier_proposal_items_buyer_request_item_id_fkey', 'FOREIGN KEY ("buyer_request_item_id") REFERENCES "buyer_request_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('order_messages', 'order_messages_order_id_fkey', 'FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
    ('order_messages', 'order_messages_sender_id_fkey', 'FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('supplier_ratings', 'supplier_ratings_order_id_fkey', 'FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
    ('supplier_ratings', 'supplier_ratings_buyer_company_id_fkey', 'FOREIGN KEY ("buyer_company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
    ('supplier_ratings', 'supplier_ratings_supplier_company_id_fkey', 'FOREIGN KEY ("supplier_company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
    ('push_tokens', 'push_tokens_user_id_fkey', 'FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE')
  ) AS t(tbl, name, def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', fk.tbl, fk.name, fk.def);
    END IF;
  END LOOP;
END $$;
