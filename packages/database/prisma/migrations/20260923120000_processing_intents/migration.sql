CREATE TYPE "ProcessingIntentKind" AS ENUM ('evidence_batch.accepted');
CREATE TYPE "ProcessingIntentState" AS ENUM ('pending', 'leased', 'delivered');

CREATE TABLE "processing_intents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "kind" "ProcessingIntentKind" NOT NULL,
    "state" "ProcessingIntentState" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "lease_expires_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    CONSTRAINT "processing_intents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "processing_intents_attempt_count_check" CHECK ("attempt_count" >= 0),
    CONSTRAINT "processing_intents_error_code_length_check" CHECK ("last_error_code" IS NULL OR length("last_error_code") BETWEEN 1 AND 128),
    CONSTRAINT "processing_intents_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_intents_org_run_fkey"
        FOREIGN KEY ("organization_id", "run_id")
        REFERENCES "runs"("organization_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_intents_org_run_batch_fkey"
        FOREIGN KEY ("organization_id", "run_id", "batch_id")
        REFERENCES "evidence_batches"("organization_id", "run_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_intents_batch_kind_key" UNIQUE ("batch_id", "kind")
);

CREATE INDEX "processing_intents_state_available_idx"
    ON "processing_intents"("state", "available_at");
