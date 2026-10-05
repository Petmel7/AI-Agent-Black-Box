ALTER TYPE "ProcessingIntentKind" ADD VALUE IF NOT EXISTS 'artifact.verified';

ALTER TABLE "processing_intents"
  ALTER COLUMN "batch_id" DROP NOT NULL,
  ADD COLUMN "artifact_declaration_id" UUID;

ALTER TABLE "processing_intents"
  DROP CONSTRAINT "processing_intents_batch_kind_key",
  ADD CONSTRAINT "processing_intents_org_run_artifact_fkey"
    FOREIGN KEY ("organization_id", "run_id", "artifact_declaration_id")
    REFERENCES "artifact_declarations"("organization_id", "run_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "processing_intents_target_coherence_check" CHECK (
    ("kind"::text = 'evidence_batch.accepted' AND "batch_id" IS NOT NULL AND "artifact_declaration_id" IS NULL)
    OR ("kind"::text = 'artifact.verified' AND "batch_id" IS NULL AND "artifact_declaration_id" IS NOT NULL)
  );

CREATE UNIQUE INDEX "processing_intents_batch_target_key"
  ON "processing_intents" ("batch_id", "kind") WHERE "batch_id" IS NOT NULL;
CREATE UNIQUE INDEX "processing_intents_artifact_target_key"
  ON "processing_intents" ("artifact_declaration_id", "kind") WHERE "artifact_declaration_id" IS NOT NULL;

ALTER TABLE "artifact_upload_attempts"
  ADD CONSTRAINT "artifact_upload_attempts_org_run_id_key"
  UNIQUE ("organization_id", "run_id", "id"),
  ADD CONSTRAINT "artifact_upload_attempts_org_run_artifact_id_key"
  UNIQUE ("organization_id", "run_id", "artifact_declaration_id", "id");

CREATE TABLE "file_run_projections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "repository_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "projector_name" TEXT NOT NULL,
  "projector_version" INTEGER NOT NULL,
  "source_event_count" INTEGER NOT NULL,
  "source_max_sequence" BIGINT,
  "source_fingerprint" TEXT NOT NULL,
  "completeness" TEXT NOT NULL,
  "completeness_reason" TEXT,
  "file_count" INTEGER NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_run_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_run_projections_run_id_key" UNIQUE ("run_id"),
  CONSTRAINT "file_runs_org_run_key" UNIQUE ("organization_id", "run_id"),
  CONSTRAINT "file_runs_projector_check" CHECK ("projector_name" = 'files' AND "projector_version" > 0),
  CONSTRAINT "file_runs_source_check" CHECK (
    "source_event_count" >= 0 AND "source_fingerprint" ~ '^[0-9a-f]{64}$'
    AND (("source_event_count" = 0 AND "source_max_sequence" IS NULL)
      OR ("source_event_count" > 0 AND "source_max_sequence" BETWEEN 0 AND 9007199254740991))
  ),
  CONSTRAINT "file_runs_completeness_check" CHECK (
    ("completeness" = 'complete' AND "completeness_reason" IS NULL)
    OR ("completeness" = 'incomplete' AND "completeness_reason" IS NOT NULL)
  ),
  CONSTRAINT "file_runs_count_check" CHECK ("file_count" >= 0),
  CONSTRAINT "file_run_projections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "file_run_projections_org_repository_fkey" FOREIGN KEY ("organization_id", "repository_id") REFERENCES "repositories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "file_run_projections_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "file_change_projections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "repository_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "source_event_id" UUID NOT NULL,
  "source_sequence" BIGINT NOT NULL,
  "diff_id" UUID NOT NULL,
  "from_snapshot_id" UUID NOT NULL,
  "to_snapshot_id" UUID NOT NULL,
  "artifact_declaration_id" UUID NOT NULL,
  "upload_attempt_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "entry_id" TEXT NOT NULL,
  "original_entry_id" TEXT,
  "display_path" TEXT NOT NULL,
  "original_display_path" TEXT,
  "display_ambiguous" BOOLEAN NOT NULL DEFAULT FALSE,
  "display_reason" TEXT,
  "before_state" JSONB,
  "after_state" JSONB,
  "attribution" TEXT NOT NULL,
  "reason" TEXT,
  CONSTRAINT "file_change_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_changes_run_event_ordinal_key" UNIQUE ("run_id", "source_event_id", "ordinal"),
  CONSTRAINT "file_changes_run_event_entry_key" UNIQUE ("run_id", "source_event_id", "entry_id"),
  CONSTRAINT "file_changes_values_check" CHECK (
    "ordinal" >= 0 AND length("entry_id") BETWEEN 1 AND 256
    AND length("display_path") BETWEEN 1 AND 32768
    AND "attribution" IN ('pre-existing', 'observed-during-run', 'mixed-or-uncertain', 'unavailable')
    AND (("display_ambiguous" AND "display_reason" = 'redaction-collision') OR (NOT "display_ambiguous" AND "display_reason" IS NULL))
    AND ("before_state" IS NOT NULL OR "after_state" IS NOT NULL)
  ),
  CONSTRAINT "file_changes_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "file_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "file_changes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "file_changes_org_repository_fkey" FOREIGN KEY ("organization_id", "repository_id") REFERENCES "repositories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "file_changes_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "file_changes_org_run_event_fkey" FOREIGN KEY ("organization_id", "run_id", "source_event_id") REFERENCES "evidence_events"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "file_changes_org_run_artifact_fkey" FOREIGN KEY ("organization_id", "run_id", "artifact_declaration_id") REFERENCES "artifact_declarations"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "file_changes_org_run_upload_fkey" FOREIGN KEY ("organization_id", "run_id", "artifact_declaration_id", "upload_attempt_id") REFERENCES "artifact_upload_attempts"("organization_id", "run_id", "artifact_declaration_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "file_changes_org_run_cursor_idx"
  ON "file_change_projections" ("organization_id", "run_id", "source_sequence", "ordinal");

-- Projection tables are mutable derived state. Existing raw append-only guards remain unchanged.
