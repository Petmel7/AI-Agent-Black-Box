ALTER TYPE "ProcessingIntentState" ADD VALUE 'blocked';

ALTER TABLE "processing_intents"
    ADD COLUMN "lease_id" UUID,
    ADD COLUMN "queue_message_id" BIGINT;

-- BBX-004 had no queue publisher or lease identity. Any manually manipulated
-- pre-009A operational state is safely replayed from its durable intent.
UPDATE "processing_intents"
   SET "state" = 'pending', "available_at" = clock_timestamp(),
       "lease_expires_at" = NULL, "delivered_at" = NULL,
       "lease_id" = NULL, "queue_message_id" = NULL
 WHERE "state" IN ('leased', 'delivered');

ALTER TABLE "processing_intents"
    ADD CONSTRAINT "processing_intents_queue_message_safe_check"
        CHECK ("queue_message_id" IS NULL OR "queue_message_id" BETWEEN 0 AND 9007199254740991),
    ADD CONSTRAINT "processing_intents_state_coherence_check" CHECK (
        ("state" = 'pending' AND "lease_id" IS NULL AND "lease_expires_at" IS NULL AND "delivered_at" IS NULL AND "queue_message_id" IS NULL)
        OR ("state" = 'leased' AND "lease_id" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "delivered_at" IS NULL AND "queue_message_id" IS NULL)
        OR ("state" = 'delivered' AND "lease_id" IS NULL AND "lease_expires_at" IS NULL AND "delivered_at" IS NOT NULL AND "queue_message_id" IS NOT NULL AND "last_error_code" IS NULL)
        OR ("state" = 'blocked' AND "lease_id" IS NULL AND "lease_expires_at" IS NULL AND "delivered_at" IS NULL AND "queue_message_id" IS NULL AND "last_error_code" IS NOT NULL)
    );

CREATE TYPE "RunProcessingStatus" AS ENUM ('pending', 'processing', 'retrying', 'ready', 'failed');

ALTER TABLE "processing_intents" ADD CONSTRAINT "processing_intents_org_run_id_key" UNIQUE ("organization_id", "run_id", "id");

CREATE TABLE "processing_application_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "projector_name" TEXT NOT NULL,
    "projector_version" INTEGER NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "processing_application_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "processing_receipts_projector_check" CHECK (length("projector_name") BETWEEN 1 AND 64 AND "projector_version" > 0),
    CONSTRAINT "processing_receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_receipts_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_receipts_org_run_intent_fkey" FOREIGN KEY ("organization_id", "run_id", "intent_id") REFERENCES "processing_intents"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_receipts_intent_projector_key" UNIQUE ("intent_id", "projector_name", "projector_version")
);

CREATE TABLE "run_processing_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "projector_name" TEXT NOT NULL,
    "projector_version" INTEGER NOT NULL,
    "state" "RunProcessingStatus" NOT NULL DEFAULT 'pending',
    "lease_id" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "attempt_deadline_at" TIMESTAMPTZ(3),
    "active_intent_id" UUID,
    "attempt_source_fingerprint" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_event_count" INTEGER,
    "source_max_sequence" BIGINT,
    "source_fingerprint" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    CONSTRAINT "run_processing_states_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "processing_states_projector_check" CHECK (length("projector_name") BETWEEN 1 AND 64 AND "projector_version" > 0),
    CONSTRAINT "processing_states_attempt_count_check" CHECK ("attempt_count" >= 0),
    CONSTRAINT "processing_states_attempt_fingerprint_check" CHECK ("attempt_source_fingerprint" IS NULL OR "attempt_source_fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "processing_states_source_check" CHECK (
        ("source_event_count" IS NULL AND "source_max_sequence" IS NULL AND "source_fingerprint" IS NULL)
        OR ("source_event_count" = 0 AND "source_max_sequence" IS NULL AND "source_fingerprint" ~ '^[0-9a-f]{64}$')
        OR ("source_event_count" > 0 AND "source_max_sequence" BETWEEN 0 AND 9007199254740991 AND "source_fingerprint" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "processing_states_error_code_check" CHECK ("last_error_code" IS NULL OR length("last_error_code") BETWEEN 1 AND 128),
    CONSTRAINT "processing_states_state_coherence_check" CHECK (
        ("state" = 'pending' AND "lease_id" IS NULL AND "lease_expires_at" IS NULL AND "attempt_deadline_at" IS NULL AND "active_intent_id" IS NULL AND "completed_at" IS NULL)
        OR ("state" = 'retrying' AND "lease_id" IS NULL AND "lease_expires_at" IS NULL AND "attempt_deadline_at" IS NULL AND "active_intent_id" IS NOT NULL AND "completed_at" IS NULL)
        OR ("state" = 'processing' AND "lease_id" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "attempt_deadline_at" IS NOT NULL AND "active_intent_id" IS NOT NULL AND "completed_at" IS NULL)
        OR ("state" = 'ready' AND "lease_id" IS NULL AND "lease_expires_at" IS NULL AND "attempt_deadline_at" IS NULL AND "active_intent_id" IS NULL AND "attempt_source_fingerprint" IS NULL AND "attempt_count" = 0 AND "completed_at" IS NOT NULL AND "last_error_code" IS NULL AND "source_event_count" IS NOT NULL)
        OR ("state" = 'failed' AND "lease_id" IS NULL AND "lease_expires_at" IS NULL AND "attempt_deadline_at" IS NULL AND "active_intent_id" IS NOT NULL AND "completed_at" IS NOT NULL AND "last_error_code" IS NOT NULL)
    ),
    CONSTRAINT "processing_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_states_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_states_org_run_active_intent_fkey" FOREIGN KEY ("organization_id", "run_id", "active_intent_id") REFERENCES "processing_intents"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_states_org_run_projector_key" UNIQUE ("organization_id", "run_id", "projector_name")
);

CREATE TABLE "processing_attempt_failures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "projector_name" TEXT NOT NULL,
    "projector_version" INTEGER NOT NULL,
    "source_fingerprint" TEXT,
    "attempt_count" INTEGER NOT NULL,
    "error_code" TEXT NOT NULL,
    "failed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "processing_attempt_failures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "processing_attempt_failures_values_check" CHECK (
        length("projector_name") BETWEEN 1 AND 64 AND "projector_version" > 0 AND "attempt_count" > 0
        AND length("error_code") BETWEEN 1 AND 128
        AND ("source_fingerprint" IS NULL OR "source_fingerprint" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "processing_attempt_failures_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_attempt_failures_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_attempt_failures_org_run_intent_fkey" FOREIGN KEY ("organization_id", "run_id", "intent_id") REFERENCES "processing_intents"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processing_attempt_failures_intent_projector_key" UNIQUE ("intent_id", "projector_name", "projector_version")
);
CREATE INDEX "processing_attempt_failures_org_run_failed_idx" ON "processing_attempt_failures"("organization_id", "run_id", "failed_at");

CREATE TABLE "core_run_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "repository_id" UUID NOT NULL, "run_id" UUID NOT NULL,
    "projector_name" TEXT NOT NULL, "projector_version" INTEGER NOT NULL, "source_event_count" INTEGER NOT NULL, "source_max_sequence" BIGINT,
    "source_fingerprint" TEXT NOT NULL, "started_event_id" UUID, "started_sequence" BIGINT, "finished_event_id" UUID, "finished_sequence" BIGINT,
    "adapter" TEXT, "provider" TEXT, "observed_outcome" TEXT, "duration_ms" BIGINT, "evidence_completeness" TEXT NOT NULL,
    "completeness_reasons" JSONB NOT NULL, "command_count" INTEGER, "tool_call_count" INTEGER, "test_observation_state" TEXT NOT NULL,
    "test_counts" JSONB NOT NULL, "token_aggregates" JSONB NOT NULL, "files_changed" BIGINT, "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "core_run_projections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "core_run_projections_run_id_key" UNIQUE ("run_id"),
    CONSTRAINT "core_runs_org_run_key" UNIQUE ("organization_id", "run_id"),
    CONSTRAINT "core_runs_projector_check" CHECK ("projector_name" = 'core' AND "projector_version" > 0),
    CONSTRAINT "core_runs_fingerprint_check" CHECK ("source_event_count" >= 0 AND "source_fingerprint" ~ '^[0-9a-f]{64}$' AND (("source_event_count" = 0 AND "source_max_sequence" IS NULL) OR ("source_event_count" > 0 AND "source_max_sequence" BETWEEN 0 AND 9007199254740991))),
    CONSTRAINT "core_runs_completeness_check" CHECK ("evidence_completeness" IN ('complete', 'incomplete') AND jsonb_typeof("completeness_reasons") = 'array'),
    CONSTRAINT "core_runs_test_state_check" CHECK ("test_observation_state" IN ('not_observed', 'observed') AND jsonb_typeof("test_counts") = 'object' AND jsonb_typeof("token_aggregates") = 'object'),
    CONSTRAINT "core_run_projections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "core_run_projections_org_repository_fkey" FOREIGN KEY ("organization_id", "repository_id") REFERENCES "repositories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "core_run_projections_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "core_runs_org_repository_cursor_idx" ON "core_run_projections"("organization_id", "repository_id", "updated_at", "run_id");

CREATE TABLE "core_command_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL, "operation_id" UUID NOT NULL,
    "start_event_id" UUID, "start_sequence" BIGINT, "finish_event_id" UUID, "finish_sequence" BIGINT, "state" TEXT NOT NULL, "outcome" TEXT,
    "duration_ms" BIGINT, "exit_code" BIGINT, "termination_signal" TEXT, "command_capture" JSONB, "working_directory" JSONB, "stdout_capture" JSONB, "stderr_capture" JSONB,
    CONSTRAINT "core_command_projections_pkey" PRIMARY KEY ("id"), CONSTRAINT "core_commands_run_operation_key" UNIQUE ("run_id", "operation_id"),
    CONSTRAINT "core_commands_state_check" CHECK ("state" IN ('complete', 'incomplete', 'conflict')),
    CONSTRAINT "core_commands_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "core_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "core_commands_org_run_sequence_idx" ON "core_command_projections"("organization_id", "run_id", "start_sequence");

CREATE TABLE "core_tool_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL, "operation_id" UUID NOT NULL,
    "start_event_id" UUID, "start_sequence" BIGINT, "finish_event_id" UUID, "finish_sequence" BIGINT, "state" TEXT NOT NULL, "tool_name" TEXT, "outcome" TEXT,
    "duration_ms" BIGINT, "input_capture" JSONB, "output_capture" JSONB,
    CONSTRAINT "core_tool_projections_pkey" PRIMARY KEY ("id"), CONSTRAINT "core_tools_run_operation_key" UNIQUE ("run_id", "operation_id"),
    CONSTRAINT "core_tools_state_check" CHECK ("state" IN ('complete', 'incomplete', 'conflict')),
    CONSTRAINT "core_tools_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "core_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "core_tools_org_run_sequence_idx" ON "core_tool_projections"("organization_id", "run_id", "start_sequence");

CREATE TABLE "core_test_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL, "test_run_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL, "source_sequence" BIGINT NOT NULL, "command_id" UUID, "framework" TEXT NOT NULL, "outcome" TEXT NOT NULL,
    "counts" JSONB, "duration_ms" BIGINT, "report_artifact_id" UUID,
    CONSTRAINT "core_test_projections_pkey" PRIMARY KEY ("id"), CONSTRAINT "core_tests_run_test_key" UNIQUE ("run_id", "test_run_id"),
    CONSTRAINT "core_tests_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "core_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "core_tests_org_run_sequence_idx" ON "core_test_projections"("organization_id", "run_id", "source_sequence");

CREATE TABLE "core_git_snapshot_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL, "snapshot_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL, "source_sequence" BIGINT NOT NULL, "phase" TEXT NOT NULL, "head_commit" TEXT, "is_dirty" BOOLEAN NOT NULL,
    "staged_file_count" BIGINT, "unstaged_file_count" BIGINT, "untracked_file_count" BIGINT, "status_artifact_id" UUID,
    CONSTRAINT "core_git_snapshot_projections_pkey" PRIMARY KEY ("id"), CONSTRAINT "core_git_snapshots_run_snapshot_key" UNIQUE ("run_id", "snapshot_id"),
    CONSTRAINT "core_git_snapshots_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "core_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "core_git_snapshots_org_run_sequence_idx" ON "core_git_snapshot_projections"("organization_id", "run_id", "source_sequence");

CREATE TABLE "core_git_diff_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL, "diff_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL, "source_sequence" BIGINT NOT NULL, "from_snapshot_id" UUID NOT NULL, "to_snapshot_id" UUID NOT NULL,
    "files_changed" BIGINT, "lines_added" BIGINT, "lines_deleted" BIGINT, "diff_artifact_id" UUID NOT NULL, "file_list_artifact_id" UUID NOT NULL,
    CONSTRAINT "core_git_diff_projections_pkey" PRIMARY KEY ("id"), CONSTRAINT "core_git_diffs_run_diff_key" UNIQUE ("run_id", "diff_id"),
    CONSTRAINT "core_git_diffs_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "core_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "core_git_diffs_org_run_sequence_idx" ON "core_git_diff_projections"("organization_id", "run_id", "source_sequence");

CREATE TABLE "core_error_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL, "error_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL, "source_sequence" BIGINT NOT NULL, "category" TEXT NOT NULL, "code" TEXT NOT NULL, "retryable" BOOLEAN,
    "message_capture" JSONB NOT NULL, "related_operation_id" UUID, "related_event_id" UUID,
    CONSTRAINT "core_error_projections_pkey" PRIMARY KEY ("id"), CONSTRAINT "core_errors_run_error_key" UNIQUE ("run_id", "error_id"),
    CONSTRAINT "core_errors_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "core_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "core_errors_org_run_sequence_idx" ON "core_error_projections"("organization_id", "run_id", "source_sequence");

CREATE TABLE "core_usage_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL, "source_event_id" UUID NOT NULL,
    "source_sequence" BIGINT NOT NULL, "provider" TEXT, "model" TEXT, "measurements" JSONB NOT NULL,
    CONSTRAINT "core_usage_projections_pkey" PRIMARY KEY ("id"), CONSTRAINT "core_usage_run_event_key" UNIQUE ("run_id", "source_event_id"),
    CONSTRAINT "core_usage_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "core_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "core_usage_org_run_sequence_idx" ON "core_usage_projections"("organization_id", "run_id", "source_sequence");

-- Derived rows are mutable only through the worker database role. Raw append-only guards are intentionally untouched.
