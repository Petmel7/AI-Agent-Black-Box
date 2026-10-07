ALTER TABLE "evidence_event_artifacts"
  ADD CONSTRAINT "event_artifacts_org_run_event_artifact_pointer_key"
  UNIQUE ("organization_id", "run_id", "event_id", "artifact_id", "json_pointer");

CREATE TABLE "findings_run_projections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL,
  "repository_id" UUID NOT NULL, "run_id" UUID NOT NULL, "projector_name" TEXT NOT NULL,
  "projector_version" INTEGER NOT NULL, "analyzer_name" TEXT NOT NULL, "analyzer_version" INTEGER NOT NULL,
  "catalog_version" INTEGER NOT NULL, "source_fingerprint" TEXT NOT NULL, "core_version" INTEGER NOT NULL,
  "core_fingerprint" TEXT NOT NULL, "core_completeness" TEXT NOT NULL, "files_version" INTEGER,
  "files_fingerprint" TEXT, "files_completeness" TEXT NOT NULL, "deterministic_outcome" TEXT NOT NULL,
  "coverage" TEXT NOT NULL, "triggered_count" INTEGER NOT NULL, "unknown_count" INTEGER NOT NULL,
  "high_count" INTEGER NOT NULL, "medium_count" INTEGER NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "findings_run_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "findings_run_projections_run_id_key" UNIQUE ("run_id"),
  CONSTRAINT "findings_runs_org_run_key" UNIQUE ("organization_id", "run_id"),
  CONSTRAINT "findings_runs_projector_check" CHECK ("projector_name" = 'findings' AND "projector_version" > 0),
  CONSTRAINT "findings_runs_versions_check" CHECK ("analyzer_version" > 0 AND "catalog_version" > 0 AND "core_version" > 0 AND ("files_version" IS NULL OR "files_version" > 0)),
  CONSTRAINT "findings_runs_fingerprint_check" CHECK ("source_fingerprint" ~ '^[0-9a-f]{64}$' AND "core_fingerprint" ~ '^[0-9a-f]{64}$' AND ("files_fingerprint" IS NULL OR "files_fingerprint" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "findings_runs_files_pair_check" CHECK (("files_version" IS NULL) = ("files_fingerprint" IS NULL)),
  CONSTRAINT "findings_runs_outcome_check" CHECK ("deterministic_outcome" IN ('pass','review','unknown')),
  CONSTRAINT "findings_runs_coverage_check" CHECK ("coverage" IN ('complete','partial')),
  CONSTRAINT "findings_runs_count_check" CHECK ("triggered_count" BETWEEN 0 AND 9 AND "unknown_count" BETWEEN 0 AND 9 AND "high_count" BETWEEN 0 AND 9 AND "medium_count" BETWEEN 0 AND 9),
  CONSTRAINT "findings_runs_pass_check" CHECK ("deterministic_outcome" <> 'pass' OR ("coverage" = 'complete' AND "triggered_count" = 0 AND "unknown_count" = 0)),
  CONSTRAINT "findings_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "findings_runs_org_repository_fkey" FOREIGN KEY ("organization_id", "repository_id") REFERENCES "repositories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "findings_runs_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "findings_runs_org_repository_cursor_idx" ON "findings_run_projections"("organization_id", "repository_id", "updated_at", "run_id");

CREATE TABLE "finding_rule_results" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL,
  "result_key" TEXT NOT NULL, "catalog_order" INTEGER NOT NULL, "rule_id" TEXT NOT NULL,
  "rule_version" INTEGER NOT NULL, "severity" TEXT NOT NULL, "outcome" TEXT NOT NULL,
  "coverage" TEXT NOT NULL, "reason_codes" JSONB NOT NULL, "explanation" TEXT NOT NULL,
  "match_count" INTEGER NOT NULL, "matches" JSONB NOT NULL, "matches_truncated" BOOLEAN NOT NULL,
  "references_truncated" BOOLEAN NOT NULL,
  CONSTRAINT "finding_rule_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finding_results_org_result_key" UNIQUE ("organization_id", "result_key"),
  CONSTRAINT "finding_results_run_rule_key" UNIQUE ("run_id", "rule_id", "rule_version"),
  CONSTRAINT "finding_results_run_order_key" UNIQUE ("run_id", "catalog_order"),
  CONSTRAINT "finding_results_org_run_id_key" UNIQUE ("organization_id", "run_id", "id"),
  CONSTRAINT "finding_results_key_check" CHECK ("result_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "finding_results_order_check" CHECK ("catalog_order" BETWEEN 0 AND 8),
  CONSTRAINT "finding_results_version_check" CHECK ("rule_version" > 0),
  CONSTRAINT "finding_results_v1_catalog_check" CHECK (
    "rule_version" = 1 AND (
      ("rule_id" = 'bbx.sensitive-area-change' AND "severity" = 'high') OR
      ("rule_id" = 'bbx.production-change-without-test-evidence' AND "severity" = 'high') OR
      ("rule_id" = 'bbx.tests-not-after-last-code-change' AND "severity" = 'high') OR
      ("rule_id" = 'bbx.final-tree-differs-from-tested-state' AND "severity" = 'high') OR
      ("rule_id" = 'bbx.repeated-failed-command' AND "severity" = 'medium') OR
      ("rule_id" = 'bbx.lockfile-without-manifest' AND "severity" = 'medium') OR
      ("rule_id" = 'bbx.test-removal-or-weakening' AND "severity" = 'high') OR
      ("rule_id" = 'bbx.out-of-scope-change' AND "severity" = 'high') OR
      ("rule_id" = 'bbx.success-claim-without-test-evidence' AND "severity" = 'high')
    )
  ),
  CONSTRAINT "finding_results_severity_check" CHECK ("severity" IN ('low','medium','high','critical')),
  CONSTRAINT "finding_results_outcome_check" CHECK ("outcome" IN ('triggered','clear','unknown')),
  CONSTRAINT "finding_results_coverage_check" CHECK ("coverage" IN ('complete','partial') AND ("outcome" <> 'clear' OR "coverage" = 'complete')),
  CONSTRAINT "finding_results_json_check" CHECK (jsonb_typeof("reason_codes") = 'array' AND jsonb_array_length("reason_codes") BETWEEN 1 AND 20 AND jsonb_typeof("matches") = 'array' AND jsonb_array_length("matches") <= 100),
  CONSTRAINT "finding_results_bounds_check" CHECK (char_length("rule_id") BETWEEN 1 AND 128 AND char_length("explanation") BETWEEN 1 AND 1000 AND "match_count" BETWEEN 0 AND 20000),
  CONSTRAINT "finding_results_org_run_projection_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "findings_run_projections"("organization_id", "run_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "finding_results_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "finding_results_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "finding_results_org_run_cursor_idx" ON "finding_rule_results"("organization_id", "run_id", "catalog_order");

CREATE TABLE "finding_evidence_references" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "run_id" UUID NOT NULL,
  "result_id" UUID NOT NULL, "ordinal" INTEGER NOT NULL, "event_id" UUID NOT NULL,
  "artifact_declaration_id" UUID, "event_artifact_pointer" TEXT, "json_pointer" TEXT, "file_ordinal" INTEGER, "entry_id" TEXT,
  CONSTRAINT "finding_evidence_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finding_refs_result_ordinal_key" UNIQUE ("result_id", "ordinal"),
  CONSTRAINT "finding_refs_identity_key" UNIQUE NULLS NOT DISTINCT ("result_id", "event_id", "artifact_declaration_id", "event_artifact_pointer", "json_pointer", "file_ordinal", "entry_id"),
  CONSTRAINT "finding_refs_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 99),
  CONSTRAINT "finding_refs_pointer_check" CHECK (
    (
      "artifact_declaration_id" IS NULL AND
      "event_artifact_pointer" IS NULL AND
      "json_pointer" IS NULL AND
      "file_ordinal" IS NULL AND
      "entry_id" IS NULL
    ) OR (
      "artifact_declaration_id" IS NOT NULL AND
      "event_artifact_pointer" IS NOT NULL AND
      "json_pointer" IS NOT NULL AND
      "event_artifact_pointer" ~ '^(/([^~/]|~[01])*)*$' AND
      "json_pointer" ~ '^(/([^~/]|~[01])*)*$' AND
      (
        ("file_ordinal" IS NULL AND "entry_id" IS NULL) OR
        (
          "file_ordinal" IS NOT NULL AND
          "entry_id" IS NOT NULL AND
          "file_ordinal" BETWEEN 0 AND 19999 AND
          char_length("entry_id") BETWEEN 1 AND 256
        )
      )
    )
  ),
  CONSTRAINT "finding_refs_org_run_result_fkey" FOREIGN KEY ("organization_id", "run_id", "result_id") REFERENCES "finding_rule_results"("organization_id", "run_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "finding_refs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "finding_refs_org_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "finding_refs_org_run_event_fkey" FOREIGN KEY ("organization_id", "run_id", "event_id") REFERENCES "evidence_events"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "finding_refs_org_run_artifact_fkey" FOREIGN KEY ("organization_id", "run_id", "artifact_declaration_id") REFERENCES "artifact_declarations"("organization_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "finding_refs_event_artifact_pointer_fkey" FOREIGN KEY ("organization_id", "run_id", "event_id", "artifact_declaration_id", "event_artifact_pointer") REFERENCES "evidence_event_artifacts"("organization_id", "run_id", "event_id", "artifact_id", "json_pointer") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION enforce_findings_run_ownership_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'findings_run_ownership_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "findings_run_ownership_guard" BEFORE UPDATE OF "organization_id", "run_id" ON "findings_run_projections" FOR EACH ROW EXECUTE FUNCTION enforce_findings_run_ownership_immutable();

CREATE FUNCTION enforce_finding_result_ownership_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finding_result_ownership_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "finding_result_ownership_guard" BEFORE UPDATE OF "id", "organization_id", "run_id" ON "finding_rule_results" FOR EACH ROW EXECUTE FUNCTION enforce_finding_result_ownership_immutable();

CREATE FUNCTION enforce_finding_reference_ownership_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.result_id IS DISTINCT FROM OLD.result_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finding_reference_ownership_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "finding_reference_ownership_guard" BEFORE UPDATE OF "organization_id", "run_id", "result_id" ON "finding_evidence_references" FOR EACH ROW EXECUTE FUNCTION enforce_finding_reference_ownership_immutable();

CREATE FUNCTION enforce_complete_findings_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_run UUID; result_total INTEGER; missing_refs INTEGER; actual_triggered INTEGER; actual_unknown INTEGER; actual_high INTEGER; actual_medium INTEGER; projection findings_run_projections%ROWTYPE;
BEGIN
  target_run := COALESCE(NEW.run_id, OLD.run_id);
  IF EXISTS (SELECT 1 FROM findings_run_projections WHERE run_id = target_run) THEN
    SELECT count(*),
           count(*) FILTER (WHERE outcome = 'triggered' AND NOT EXISTS (SELECT 1 FROM finding_evidence_references ref WHERE ref.result_id = result.id)),
           count(*) FILTER (WHERE outcome = 'triggered'), count(*) FILTER (WHERE outcome = 'unknown'),
           count(*) FILTER (WHERE outcome = 'triggered' AND severity = 'high'), count(*) FILTER (WHERE outcome = 'triggered' AND severity = 'medium')
      INTO result_total, missing_refs, actual_triggered, actual_unknown, actual_high, actual_medium
      FROM finding_rule_results result WHERE result.run_id = target_run;
    SELECT * INTO projection FROM findings_run_projections WHERE run_id = target_run;
    IF result_total <> 9 THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'findings_catalog_incomplete'; END IF;
    IF missing_refs <> 0 THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'triggered_finding_requires_evidence'; END IF;
    IF projection.triggered_count <> actual_triggered OR projection.unknown_count <> actual_unknown OR projection.high_count <> actual_high OR projection.medium_count <> actual_medium THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'findings_catalog_count_mismatch';
    END IF;
    IF projection.deterministic_outcome = 'review' AND actual_triggered = 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'findings_review_requires_trigger';
    END IF;
    IF projection.deterministic_outcome = 'unknown' AND (actual_triggered <> 0 OR actual_unknown = 0) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'findings_unknown_outcome_mismatch';
    END IF;
    IF projection.deterministic_outcome = 'pass' AND (actual_triggered <> 0 OR actual_unknown <> 0 OR EXISTS (SELECT 1 FROM finding_rule_results WHERE run_id = target_run AND (outcome <> 'clear' OR coverage <> 'complete'))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'findings_pass_outcome_mismatch';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "findings_catalog_complete_guard" AFTER INSERT OR UPDATE ON "findings_run_projections" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_complete_findings_catalog();
CREATE CONSTRAINT TRIGGER "findings_result_complete_guard" AFTER INSERT OR UPDATE OR DELETE ON "finding_rule_results" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_complete_findings_catalog();
CREATE CONSTRAINT TRIGGER "findings_reference_complete_guard" AFTER INSERT OR UPDATE OR DELETE ON "finding_evidence_references" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_complete_findings_catalog();
