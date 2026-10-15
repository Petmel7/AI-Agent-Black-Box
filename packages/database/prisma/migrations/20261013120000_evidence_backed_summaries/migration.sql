ALTER TABLE "findings_run_projections"
  ADD CONSTRAINT "findings_runs_org_run_source_key"
  UNIQUE ("organization_id", "run_id", "source_fingerprint");

ALTER TABLE "finding_rule_results"
  ADD CONSTRAINT "finding_results_exact_support_key"
  UNIQUE ("organization_id", "run_id", "id", "result_key", "rule_id", "rule_version");

CREATE TABLE "summary_run_projections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "repository_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "projector_name" TEXT NOT NULL,
  "projector_version" INTEGER NOT NULL,
  "generator_name" TEXT NOT NULL,
  "generator_version" INTEGER NOT NULL,
  "format_version" INTEGER NOT NULL,
  "template_version" INTEGER NOT NULL,
  "summary_key" TEXT NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "core_version" INTEGER NOT NULL,
  "core_fingerprint" TEXT NOT NULL,
  "core_completeness" TEXT NOT NULL,
  "files_version" INTEGER,
  "files_fingerprint" TEXT,
  "files_completeness" TEXT NOT NULL,
  "findings_projector_version" INTEGER NOT NULL,
  "findings_fingerprint" TEXT NOT NULL,
  "findings_analyzer_name" TEXT NOT NULL,
  "findings_analyzer_version" INTEGER NOT NULL,
  "findings_catalog_version" INTEGER NOT NULL,
  "summary_outcome" TEXT NOT NULL,
  "section_count" INTEGER NOT NULL,
  "claim_count" INTEGER NOT NULL,
  "claims_truncated" BOOLEAN NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "summary_run_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "summary_run_projections_run_id_key" UNIQUE ("run_id"),
  CONSTRAINT "summary_runs_org_summary_key" UNIQUE ("organization_id", "summary_key"),
  CONSTRAINT "summary_runs_org_run_key" UNIQUE ("organization_id", "run_id"),
  CONSTRAINT "summary_runs_org_run_findings_key" UNIQUE ("organization_id", "run_id", "findings_fingerprint"),
  CONSTRAINT "summary_runs_projector_check" CHECK ("projector_name" = 'summary' AND "projector_version" = 1),
  CONSTRAINT "summary_runs_generator_check" CHECK ("generator_name" = 'deterministic-structured-summary' AND "generator_version" = 1 AND "format_version" = 1 AND "template_version" = 1),
  CONSTRAINT "summary_runs_version_check" CHECK ("core_version" > 0 AND ("files_version" IS NULL OR "files_version" > 0) AND "findings_projector_version" > 0 AND "findings_analyzer_version" > 0 AND "findings_catalog_version" > 0),
  CONSTRAINT "summary_runs_fingerprint_check" CHECK (
    "summary_key" ~ '^[0-9a-f]{64}$' AND "source_fingerprint" ~ '^[0-9a-f]{64}$' AND
    "core_fingerprint" ~ '^[0-9a-f]{64}$' AND
    ("files_fingerprint" IS NULL OR "files_fingerprint" ~ '^[0-9a-f]{64}$') AND
    "findings_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "summary_runs_files_pair_check" CHECK (("files_version" IS NULL) = ("files_fingerprint" IS NULL)),
  CONSTRAINT "summary_runs_outcome_check" CHECK ("summary_outcome" IN ('pass','review','unknown')),
  CONSTRAINT "summary_runs_count_check" CHECK ("section_count" BETWEEN 1 AND 4 AND "claim_count" BETWEEN 1 AND 100),
  CONSTRAINT "summary_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_runs_org_repository_fkey" FOREIGN KEY ("organization_id", "repository_id") REFERENCES "repositories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_runs_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_runs_findings_snapshot_fkey" FOREIGN KEY ("organization_id", "run_id", "findings_fingerprint") REFERENCES "findings_run_projections"("organization_id", "run_id", "source_fingerprint") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "summary_runs_org_repository_cursor_idx" ON "summary_run_projections"("organization_id", "repository_id", "updated_at", "run_id");

CREATE TABLE "summary_claims" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "claim_key" TEXT NOT NULL,
  "stable_id" TEXT NOT NULL,
  "section_id" TEXT NOT NULL,
  "section_order" INTEGER NOT NULL,
  "claim_order" INTEGER NOT NULL,
  "claim_class" TEXT NOT NULL,
  "template_id" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "support_count" INTEGER NOT NULL,
  "supports_truncated" BOOLEAN NOT NULL,
  CONSTRAINT "summary_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "summary_claims_org_claim_key" UNIQUE ("organization_id", "claim_key"),
  CONSTRAINT "summary_claims_run_stable_id_key" UNIQUE ("run_id", "stable_id"),
  CONSTRAINT "summary_claims_run_order_key" UNIQUE ("run_id", "section_order", "claim_order"),
  CONSTRAINT "summary_claims_org_run_id_key" UNIQUE ("organization_id", "run_id", "id"),
  CONSTRAINT "summary_claims_org_run_id_class_key" UNIQUE ("organization_id", "run_id", "id", "claim_class"),
  CONSTRAINT "summary_claims_key_check" CHECK ("claim_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "summary_claims_identity_check" CHECK ("stable_id" ~ '^[a-z0-9][a-z0-9._-]{0,159}$' AND "template_id" ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  CONSTRAINT "summary_claims_section_check" CHECK (
    ("section_id" = 'run' AND "section_order" = 0) OR
    ("section_id" = 'evidence' AND "section_order" = 1) OR
    ("section_id" = 'findings' AND "section_order" = 2) OR
    ("section_id" = 'limitations' AND "section_order" = 3)
  ),
  CONSTRAINT "summary_claims_order_check" CHECK ("claim_order" BETWEEN 0 AND 99),
  CONSTRAINT "summary_claims_class_check" CHECK ("claim_class" IN ('observation','deterministic_assessment','limitation')),
  CONSTRAINT "summary_claims_v1_template_check" CHECK (
    ("template_id" = 'v1.run.observed-outcome' AND "claim_class" = 'observation' AND "section_id" = 'run') OR
    ("template_id" IN ('v1.evidence.git-diff-observations','v1.evidence.test-observations') AND "claim_class" = 'observation' AND "section_id" = 'evidence') OR
    ("template_id" IN ('v1.findings.bounded-pass','v1.findings.triggered-rule') AND "claim_class" = 'deterministic_assessment' AND "section_id" = 'findings') OR
    ("template_id" IN ('v1.limitations.unknown-rule','v1.limitations.core-incomplete','v1.limitations.files-incomplete','v1.limitations.run-outcome-unavailable','v1.limitations.git-change-unavailable','v1.limitations.tests-unavailable') AND "claim_class" = 'limitation' AND "section_id" = 'limitations')
  ),
  CONSTRAINT "summary_claims_text_check" CHECK (char_length("text") BETWEEN 1 AND 1000),
  CONSTRAINT "summary_claims_support_count_check" CHECK ("support_count" BETWEEN 1 AND 100),
  CONSTRAINT "summary_claims_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "summary_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "summary_claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_claims_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "summary_claims_org_run_cursor_idx" ON "summary_claims"("organization_id", "run_id", "section_order", "claim_order");

CREATE TABLE "summary_claim_supports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "claim_id" UUID NOT NULL,
  "claim_class" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "support_kind" TEXT NOT NULL,
  "event_id" UUID,
  "artifact_declaration_id" UUID,
  "event_artifact_pointer" TEXT,
  "json_pointer" TEXT,
  "file_ordinal" INTEGER,
  "entry_id" TEXT,
  "finding_result_id" UUID,
  "finding_result_key" TEXT,
  "finding_rule_id" TEXT,
  "finding_rule_version" INTEGER,
  "findings_source_fingerprint" TEXT,
  CONSTRAINT "summary_claim_supports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "summary_supports_claim_ordinal_key" UNIQUE ("claim_id", "ordinal"),
  CONSTRAINT "summary_supports_identity_key" UNIQUE NULLS NOT DISTINCT ("claim_id", "support_kind", "event_id", "artifact_declaration_id", "event_artifact_pointer", "json_pointer", "file_ordinal", "entry_id", "finding_result_id", "finding_result_key", "finding_rule_id", "finding_rule_version", "findings_source_fingerprint"),
  CONSTRAINT "summary_supports_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 99),
  CONSTRAINT "summary_supports_kind_check" CHECK ((
    (
      "support_kind" = 'evidence' AND "claim_class" = 'observation' AND "event_id" IS NOT NULL AND
      "finding_result_id" IS NULL AND "finding_result_key" IS NULL AND "finding_rule_id" IS NULL AND
      "finding_rule_version" IS NULL AND "findings_source_fingerprint" IS NULL AND
      (
        ("artifact_declaration_id" IS NULL AND "event_artifact_pointer" IS NULL AND "json_pointer" IS NULL AND "file_ordinal" IS NULL AND "entry_id" IS NULL) OR
        ("artifact_declaration_id" IS NOT NULL AND "event_artifact_pointer" IS NOT NULL AND "json_pointer" IS NOT NULL AND
          char_length("event_artifact_pointer") <= 2048 AND char_length("json_pointer") <= 2048 AND
          "event_artifact_pointer" ~ '^(/([^~/]|~[01])*)*$' AND "json_pointer" ~ '^(/([^~/]|~[01])*)*$' AND
          (("file_ordinal" IS NULL AND "entry_id" IS NULL) OR ("file_ordinal" IS NOT NULL AND "entry_id" IS NOT NULL AND "file_ordinal" BETWEEN 0 AND 19999 AND char_length("entry_id") BETWEEN 1 AND 256))
        )
      )
    ) OR (
      "support_kind" = 'finding' AND "claim_class" IN ('deterministic_assessment','limitation') AND
      "event_id" IS NULL AND "artifact_declaration_id" IS NULL AND "event_artifact_pointer" IS NULL AND
      "json_pointer" IS NULL AND "file_ordinal" IS NULL AND "entry_id" IS NULL AND
      "finding_result_id" IS NOT NULL AND
      "finding_result_key" IS NOT NULL AND "finding_result_key" ~ '^[0-9a-f]{64}$' AND
      "finding_rule_id" IS NOT NULL AND char_length("finding_rule_id") BETWEEN 1 AND 128 AND
      "finding_rule_version" IS NOT NULL AND "finding_rule_version" > 0 AND
      "findings_source_fingerprint" IS NOT NULL AND "findings_source_fingerprint" ~ '^[0-9a-f]{64}$'
    )
  ) IS TRUE),
  CONSTRAINT "summary_supports_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "summary_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "summary_supports_claim_class_fkey" FOREIGN KEY ("organization_id", "run_id", "claim_id", "claim_class") REFERENCES "summary_claims"("organization_id", "run_id", "id", "claim_class") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "summary_supports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_supports_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_supports_org_run_event_fkey" FOREIGN KEY ("organization_id", "run_id", "event_id") REFERENCES "evidence_events"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_supports_org_run_artifact_fkey" FOREIGN KEY ("organization_id", "run_id", "artifact_declaration_id") REFERENCES "artifact_declarations"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_supports_event_artifact_pointer_fkey" FOREIGN KEY ("organization_id", "run_id", "event_id", "artifact_declaration_id", "event_artifact_pointer") REFERENCES "evidence_event_artifacts"("organization_id", "run_id", "event_id", "artifact_id", "json_pointer") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_supports_finding_result_fkey" FOREIGN KEY ("organization_id", "run_id", "finding_result_id", "finding_result_key", "finding_rule_id", "finding_rule_version") REFERENCES "finding_rule_results"("organization_id", "run_id", "id", "result_key", "rule_id", "rule_version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "summary_supports_findings_snapshot_fkey" FOREIGN KEY ("organization_id", "run_id", "findings_source_fingerprint") REFERENCES "summary_run_projections"("organization_id", "run_id", "findings_fingerprint") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "summary_supports_org_run_claim_cursor_idx" ON "summary_claim_supports"("organization_id", "run_id", "claim_id", "ordinal");

CREATE FUNCTION enforce_summary_findings_compatibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE projection findings_run_projections%ROWTYPE;
BEGIN
  SELECT * INTO projection
    FROM findings_run_projections
   WHERE organization_id = NEW.organization_id
     AND run_id = NEW.run_id
     AND source_fingerprint = NEW.findings_fingerprint;
  IF NOT FOUND OR
     NEW.summary_outcome IS DISTINCT FROM projection.deterministic_outcome OR
     NEW.findings_projector_version IS DISTINCT FROM projection.projector_version OR
     NEW.findings_analyzer_name IS DISTINCT FROM projection.analyzer_name OR
     NEW.findings_analyzer_version IS DISTINCT FROM projection.analyzer_version OR
     NEW.findings_catalog_version IS DISTINCT FROM projection.catalog_version THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'summary_findings_snapshot_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "summary_findings_compatibility_guard" BEFORE INSERT OR UPDATE OF "organization_id", "run_id", "findings_fingerprint", "summary_outcome", "findings_projector_version", "findings_analyzer_name", "findings_analyzer_version", "findings_catalog_version" ON "summary_run_projections" FOR EACH ROW EXECUTE FUNCTION enforce_summary_findings_compatibility();

-- Findings are replaceable derived state, but a persisted summary is valid only
-- for the exact material findings snapshot. Direct SQL and future writers must
-- receive the same atomic invalidation guarantee as the projector service.
CREATE FUNCTION invalidate_summary_for_findings_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_organization UUID;
  target_run UUID;
BEGIN
  target_organization := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  target_run := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  DELETE FROM summary_run_projections
   WHERE organization_id = target_organization
     AND run_id = target_run;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER "findings_projection_summary_invalidation_update"
BEFORE UPDATE OF "repository_id", "projector_name", "projector_version", "analyzer_name", "analyzer_version", "catalog_version", "source_fingerprint", "core_version", "core_fingerprint", "core_completeness", "files_version", "files_fingerprint", "files_completeness", "deterministic_outcome", "coverage", "triggered_count", "unknown_count", "high_count", "medium_count"
ON "findings_run_projections" FOR EACH ROW EXECUTE FUNCTION invalidate_summary_for_findings_mutation();
CREATE TRIGGER "findings_projection_summary_invalidation_delete"
BEFORE DELETE ON "findings_run_projections" FOR EACH ROW EXECUTE FUNCTION invalidate_summary_for_findings_mutation();

CREATE TRIGGER "finding_result_summary_invalidation_write"
BEFORE INSERT OR DELETE ON "finding_rule_results" FOR EACH ROW EXECUTE FUNCTION invalidate_summary_for_findings_mutation();
CREATE TRIGGER "finding_result_summary_invalidation_update"
BEFORE UPDATE OF "result_key", "catalog_order", "rule_id", "rule_version", "severity", "outcome", "coverage", "reason_codes", "explanation", "match_count", "matches", "matches_truncated", "references_truncated"
ON "finding_rule_results" FOR EACH ROW EXECUTE FUNCTION invalidate_summary_for_findings_mutation();

CREATE TRIGGER "finding_reference_summary_invalidation_write"
BEFORE INSERT OR DELETE ON "finding_evidence_references" FOR EACH ROW EXECUTE FUNCTION invalidate_summary_for_findings_mutation();
CREATE TRIGGER "finding_reference_summary_invalidation_update"
BEFORE UPDATE OF "ordinal", "event_id", "artifact_declaration_id", "event_artifact_pointer", "json_pointer", "file_ordinal", "entry_id"
ON "finding_evidence_references" FOR EACH ROW EXECUTE FUNCTION invalidate_summary_for_findings_mutation();

CREATE FUNCTION enforce_summary_run_ownership_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'summary_run_ownership_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "summary_run_ownership_guard" BEFORE UPDATE OF "organization_id", "run_id" ON "summary_run_projections" FOR EACH ROW EXECUTE FUNCTION enforce_summary_run_ownership_immutable();

CREATE FUNCTION enforce_summary_claim_ownership_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.claim_class IS DISTINCT FROM OLD.claim_class THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'summary_claim_ownership_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "summary_claim_ownership_guard" BEFORE UPDATE OF "id", "organization_id", "run_id", "claim_class" ON "summary_claims" FOR EACH ROW EXECUTE FUNCTION enforce_summary_claim_ownership_immutable();

CREATE FUNCTION enforce_summary_support_ownership_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.claim_class IS DISTINCT FROM OLD.claim_class THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'summary_support_ownership_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "summary_support_ownership_guard" BEFORE UPDATE OF "organization_id", "run_id", "claim_id", "claim_class" ON "summary_claim_supports" FOR EACH ROW EXECUTE FUNCTION enforce_summary_support_ownership_immutable();

CREATE FUNCTION enforce_complete_summary_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_run UUID;
  projection summary_run_projections%ROWTYPE;
  actual_claims INTEGER;
  actual_sections INTEGER;
  unsupported_claims INTEGER;
  count_mismatches INTEGER;
  ordering_errors INTEGER;
BEGIN
  target_run := COALESCE(NEW.run_id, OLD.run_id);
  IF EXISTS (SELECT 1 FROM summary_run_projections WHERE run_id = target_run) THEN
    SELECT * INTO projection FROM summary_run_projections WHERE run_id = target_run;
    SELECT count(*), count(DISTINCT section_id),
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM summary_claim_supports support WHERE support.claim_id = claim.id)),
           count(*) FILTER (WHERE support_count <> (SELECT count(*) FROM summary_claim_supports support WHERE support.claim_id = claim.id)),
           count(*) FILTER (WHERE claim_order <> (SELECT count(*) FROM summary_claims prior WHERE prior.run_id = claim.run_id AND prior.section_order = claim.section_order AND prior.claim_order < claim.claim_order)
             OR support_count - 1 <> (SELECT max(support.ordinal) FROM summary_claim_supports support WHERE support.claim_id = claim.id))
      INTO actual_claims, actual_sections, unsupported_claims, count_mismatches, ordering_errors
      FROM summary_claims claim WHERE claim.run_id = target_run;
    IF projection.claim_count <> actual_claims OR projection.section_count <> actual_sections THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'summary_snapshot_count_mismatch';
    END IF;
    IF unsupported_claims <> 0 OR count_mismatches <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'summary_claim_support_incomplete';
    END IF;
    IF ordering_errors <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'summary_snapshot_order_invalid';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "summary_snapshot_complete_guard" AFTER INSERT OR UPDATE ON "summary_run_projections" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_complete_summary_snapshot();
CREATE CONSTRAINT TRIGGER "summary_claim_complete_guard" AFTER INSERT OR UPDATE OR DELETE ON "summary_claims" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_complete_summary_snapshot();
CREATE CONSTRAINT TRIGGER "summary_support_complete_guard" AFTER INSERT OR UPDATE OR DELETE ON "summary_claim_supports" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_complete_summary_snapshot();
