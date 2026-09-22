CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repositories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repositories_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "repositories_org_id_key" UNIQUE ("organization_id", "id")
);

CREATE TABLE "runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "canonical_run_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "runs_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "runs_org_repository_fkey"
        FOREIGN KEY ("organization_id", "repository_id")
        REFERENCES "repositories"("organization_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "runs_org_canonical_run_id_key"
        UNIQUE ("organization_id", "canonical_run_id"),
    CONSTRAINT "runs_org_id_key" UNIQUE ("organization_id", "id")
);

CREATE TABLE "evidence_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "canonical_batch_id" UUID NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_batch" JSONB NOT NULL,
    CONSTRAINT "evidence_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "batches_schema_version_check" CHECK ("schema_version" = 1),
    CONSTRAINT "batches_raw_batch_object_check"
        CHECK (jsonb_typeof("raw_batch") = 'object'),
    CONSTRAINT "batches_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "batches_org_run_fkey"
        FOREIGN KEY ("organization_id", "run_id")
        REFERENCES "runs"("organization_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "batches_org_canonical_batch_id_key"
        UNIQUE ("organization_id", "canonical_batch_id"),
    CONSTRAINT "batches_org_run_id_key"
        UNIQUE ("organization_id", "run_id", "id")
);

CREATE TABLE "evidence_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "canonical_event_id" UUID NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "sequence" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_event" JSONB NOT NULL,
    CONSTRAINT "evidence_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "events_schema_version_check" CHECK ("schema_version" = 1),
    CONSTRAINT "events_sequence_safe_integer_check"
        CHECK ("sequence" BETWEEN 0 AND 9007199254740991),
    CONSTRAINT "events_kind_nonempty_check" CHECK (length("kind") > 0),
    CONSTRAINT "events_raw_event_object_check"
        CHECK (jsonb_typeof("raw_event") = 'object'),
    CONSTRAINT "events_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "events_org_run_fkey"
        FOREIGN KEY ("organization_id", "run_id")
        REFERENCES "runs"("organization_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "events_org_canonical_event_id_key"
        UNIQUE ("organization_id", "canonical_event_id"),
    CONSTRAINT "events_run_sequence_key" UNIQUE ("run_id", "sequence"),
    CONSTRAINT "events_org_run_id_key"
        UNIQUE ("organization_id", "run_id", "id")
);

CREATE TABLE "evidence_batch_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "position" BIGINT NOT NULL,
    CONSTRAINT "evidence_batch_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "batch_events_position_safe_integer_check"
        CHECK ("position" BETWEEN 0 AND 9007199254740991),
    CONSTRAINT "batch_events_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "batch_events_org_run_fkey"
        FOREIGN KEY ("organization_id", "run_id")
        REFERENCES "runs"("organization_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "batch_events_org_run_batch_fkey"
        FOREIGN KEY ("organization_id", "run_id", "batch_id")
        REFERENCES "evidence_batches"("organization_id", "run_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "batch_events_org_run_event_fkey"
        FOREIGN KEY ("organization_id", "run_id", "event_id")
        REFERENCES "evidence_events"("organization_id", "run_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "batch_events_batch_position_key"
        UNIQUE ("batch_id", "position"),
    CONSTRAINT "batch_events_batch_event_key" UNIQUE ("batch_id", "event_id")
);

CREATE TABLE "artifact_declarations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "canonical_artifact_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "byte_length" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "redaction_applied" BOOLEAN NOT NULL,
    "redaction_ruleset_version" TEXT,
    "compression" TEXT,
    "character_encoding" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_reference" JSONB NOT NULL,
    CONSTRAINT "artifact_declarations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifacts_byte_length_safe_integer_check"
        CHECK ("byte_length" BETWEEN 0 AND 9007199254740991),
    CONSTRAINT "artifacts_sha256_lowercase_check"
        CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "artifacts_redaction_ruleset_check"
        CHECK ("redaction_applied" OR "redaction_ruleset_version" IS NULL),
    CONSTRAINT "artifacts_kind_nonempty_check" CHECK (length("kind") > 0),
    CONSTRAINT "artifacts_media_type_nonempty_check"
        CHECK (length("media_type") > 0),
    CONSTRAINT "artifacts_raw_reference_object_check"
        CHECK (jsonb_typeof("raw_reference") = 'object'),
    CONSTRAINT "artifacts_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "artifacts_org_run_fkey"
        FOREIGN KEY ("organization_id", "run_id")
        REFERENCES "runs"("organization_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "artifacts_org_canonical_artifact_id_key"
        UNIQUE ("organization_id", "canonical_artifact_id"),
    CONSTRAINT "artifacts_org_run_id_key"
        UNIQUE ("organization_id", "run_id", "id")
);

CREATE TABLE "evidence_event_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "json_pointer" TEXT NOT NULL,
    CONSTRAINT "evidence_event_artifacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_artifacts_json_pointer_check"
        CHECK (
            "json_pointer" = '' OR
            ("json_pointer" LIKE '/%' AND "json_pointer" !~ '~(?:[^01]|$)')
        ),
    CONSTRAINT "event_artifacts_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "event_artifacts_org_run_fkey"
        FOREIGN KEY ("organization_id", "run_id")
        REFERENCES "runs"("organization_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "event_artifacts_org_run_event_fkey"
        FOREIGN KEY ("organization_id", "run_id", "event_id")
        REFERENCES "evidence_events"("organization_id", "run_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "event_artifacts_org_run_artifact_fkey"
        FOREIGN KEY ("organization_id", "run_id", "artifact_id")
        REFERENCES "artifact_declarations"("organization_id", "run_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "event_artifacts_event_pointer_key"
        UNIQUE ("event_id", "json_pointer")
);

CREATE INDEX "batches_org_run_received_idx"
    ON "evidence_batches"("organization_id", "run_id", "received_at");
CREATE INDEX "events_org_run_kind_idx"
    ON "evidence_events"("organization_id", "run_id", "kind");
CREATE INDEX "artifacts_org_run_kind_idx"
    ON "artifact_declarations"("organization_id", "run_id", "kind");

-- REVIEW GUARDS START
CREATE FUNCTION "validate_evidence_batch_consistency"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    stored_canonical_run_id UUID;
    raw_sent_at TIMESTAMPTZ(3);
    scalar_sent_at TIMESTAMPTZ(3);
BEGIN
    SELECT "canonical_run_id"
      INTO stored_canonical_run_id
      FROM "runs"
     WHERE "organization_id" = NEW."organization_id"
       AND "id" = NEW."run_id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    raw_sent_at := (NEW."raw_batch" ->> 'sentAt')::TIMESTAMPTZ;
    scalar_sent_at := NEW."sent_at";

    IF jsonb_typeof(NEW."raw_batch" -> 'events') IS DISTINCT FROM 'array'
       OR NEW."raw_batch" -> 'schemaVersion' IS DISTINCT FROM to_jsonb(NEW."schema_version")
       OR NEW."raw_batch" ->> 'batchId' IS DISTINCT FROM NEW."canonical_batch_id"::TEXT
       OR NEW."raw_batch" ->> 'runId' IS DISTINCT FROM stored_canonical_run_id::TEXT
       OR raw_sent_at IS DISTINCT FROM scalar_sent_at THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'batches_raw_scalar_consistency_check',
            MESSAGE = 'raw batch fields must match persisted batch fields';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "batches_validate_raw_consistency"
BEFORE INSERT ON "evidence_batches"
FOR EACH ROW EXECUTE FUNCTION "validate_evidence_batch_consistency"();

CREATE FUNCTION "validate_evidence_event_consistency"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    stored_canonical_run_id UUID;
    raw_observed_at TIMESTAMPTZ(3);
    scalar_observed_at TIMESTAMPTZ(3);
    raw_occurred_at TIMESTAMPTZ(3);
    scalar_occurred_at TIMESTAMPTZ(3);
BEGIN
    SELECT "canonical_run_id"
      INTO stored_canonical_run_id
      FROM "runs"
     WHERE "organization_id" = NEW."organization_id"
       AND "id" = NEW."run_id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    raw_observed_at := (NEW."raw_event" ->> 'observedAt')::TIMESTAMPTZ;
    scalar_observed_at := NEW."observed_at";

    IF NEW."raw_event" -> 'schemaVersion' IS DISTINCT FROM to_jsonb(NEW."schema_version")
       OR NEW."raw_event" ->> 'eventId' IS DISTINCT FROM NEW."canonical_event_id"::TEXT
       OR NEW."raw_event" ->> 'runId' IS DISTINCT FROM stored_canonical_run_id::TEXT
       OR (NEW."raw_event" ->> 'sequence')::BIGINT IS DISTINCT FROM NEW."sequence"
       OR NEW."raw_event" ->> 'kind' IS DISTINCT FROM NEW."kind"
       OR raw_observed_at IS DISTINCT FROM scalar_observed_at THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'events_raw_scalar_consistency_check',
            MESSAGE = 'raw event fields must match persisted event fields';
    END IF;

    IF NEW."raw_event" ? 'occurredAt' THEN
        raw_occurred_at := (NEW."raw_event" ->> 'occurredAt')::TIMESTAMPTZ;
        scalar_occurred_at := NEW."occurred_at";
        IF NEW."occurred_at" IS NULL
           OR raw_occurred_at IS DISTINCT FROM scalar_occurred_at THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'events_raw_occurred_at_consistency_check',
                MESSAGE = 'raw event occurredAt must match persisted occurred_at';
        END IF;
    ELSIF NEW."occurred_at" IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'events_raw_occurred_at_consistency_check',
            MESSAGE = 'persisted occurred_at requires raw event occurredAt';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "events_validate_raw_consistency"
BEFORE INSERT ON "evidence_events"
FOR EACH ROW EXECUTE FUNCTION "validate_evidence_event_consistency"();

CREATE FUNCTION "validate_artifact_declaration_consistency"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    expected_redaction JSONB;
BEGIN
    expected_redaction := jsonb_build_object('applied', NEW."redaction_applied");
    IF NEW."redaction_ruleset_version" IS NOT NULL THEN
        expected_redaction := expected_redaction || jsonb_build_object(
            'rulesetVersion', NEW."redaction_ruleset_version"
        );
    END IF;

    IF NEW."raw_reference" ->> 'artifactId' IS DISTINCT FROM NEW."canonical_artifact_id"::TEXT
       OR NEW."raw_reference" ->> 'kind' IS DISTINCT FROM NEW."kind"
       OR NEW."raw_reference" ->> 'mediaType' IS DISTINCT FROM NEW."media_type"
       OR (NEW."raw_reference" ->> 'byteLength')::BIGINT IS DISTINCT FROM NEW."byte_length"
       OR NEW."raw_reference" ->> 'sha256' IS DISTINCT FROM NEW."sha256"
       OR NEW."raw_reference" -> 'redaction' IS DISTINCT FROM expected_redaction
       OR (NEW."raw_reference" ? 'compression') <> (NEW."compression" IS NOT NULL)
       OR (NEW."raw_reference" ? 'compression' AND NEW."raw_reference" ->> 'compression' IS DISTINCT FROM NEW."compression")
       OR (NEW."raw_reference" ? 'characterEncoding') <> (NEW."character_encoding" IS NOT NULL)
       OR (NEW."raw_reference" ? 'characterEncoding' AND NEW."raw_reference" ->> 'characterEncoding' IS DISTINCT FROM NEW."character_encoding") THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'artifacts_raw_scalar_consistency_check',
            MESSAGE = 'raw artifact reference must match persisted artifact fields';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "artifacts_validate_raw_consistency"
BEFORE INSERT ON "artifact_declarations"
FOR EACH ROW EXECUTE FUNCTION "validate_artifact_declaration_consistency"();

CREATE FUNCTION "validate_batch_event_consistency"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    batch_document JSONB;
    event_document JSONB;
    batch_event_document JSONB;
BEGIN
    SELECT "raw_batch"
      INTO batch_document
      FROM "evidence_batches"
     WHERE "organization_id" = NEW."organization_id"
       AND "run_id" = NEW."run_id"
       AND "id" = NEW."batch_id";

    SELECT "raw_event"
      INTO event_document
      FROM "evidence_events"
     WHERE "organization_id" = NEW."organization_id"
       AND "run_id" = NEW."run_id"
       AND "id" = NEW."event_id";

    IF batch_document IS NULL OR event_document IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW."position" < 0 OR NEW."position" > 9007199254740991 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'batch_events_position_safe_integer_check',
            MESSAGE = 'batch membership position must be a non-negative safe integer';
    END IF;

    IF NEW."position" >= jsonb_array_length(batch_document -> 'events') THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'batch_events_raw_position_check',
            MESSAGE = 'batch membership position must identify a raw batch event';
    END IF;

    batch_event_document := batch_document -> 'events' -> NEW."position"::INTEGER;
    IF batch_event_document IS DISTINCT FROM event_document THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'batch_events_raw_event_consistency_check',
            MESSAGE = 'batch membership event must equal the raw batch event at position';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "batch_events_validate_raw_consistency"
BEFORE INSERT ON "evidence_batch_events"
FOR EACH ROW EXECUTE FUNCTION "validate_batch_event_consistency"();

CREATE FUNCTION "resolve_json_pointer"(document JSONB, pointer TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    path_tokens TEXT[];
    token_index INTEGER;
BEGIN
    IF pointer = '' THEN
        RETURN document;
    ELSIF pointer = '/' THEN
        path_tokens := ARRAY[''];
    ELSE
        path_tokens := string_to_array(substring(pointer FROM 2), '/');
    END IF;

    FOR token_index IN array_lower(path_tokens, 1)..array_upper(path_tokens, 1) LOOP
        path_tokens[token_index] := replace(
            replace(path_tokens[token_index], '~1', '/'),
            '~0',
            '~'
        );
    END LOOP;

    RETURN document #> path_tokens;
END;
$$;

CREATE FUNCTION "validate_event_artifact_reference"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    event_document JSONB;
    artifact_reference JSONB;
    pointer_target JSONB;
BEGIN
    SELECT "raw_event"
      INTO event_document
      FROM "evidence_events"
     WHERE "organization_id" = NEW."organization_id"
       AND "run_id" = NEW."run_id"
       AND "id" = NEW."event_id";

    SELECT "raw_reference"
      INTO artifact_reference
      FROM "artifact_declarations"
     WHERE "organization_id" = NEW."organization_id"
       AND "run_id" = NEW."run_id"
       AND "id" = NEW."artifact_id";

    IF event_document IS NULL OR artifact_reference IS NULL THEN
        RETURN NEW;
    END IF;

    pointer_target := "resolve_json_pointer"(event_document, NEW."json_pointer");
    IF pointer_target IS NULL OR pointer_target IS DISTINCT FROM artifact_reference THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'event_artifacts_reference_match_check',
            MESSAGE = 'event artifact pointer must resolve to the declared artifact reference';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "event_artifacts_validate_reference"
BEFORE INSERT ON "evidence_event_artifacts"
FOR EACH ROW EXECUTE FUNCTION "validate_event_artifact_reference"();
-- REVIEW GUARDS END

CREATE FUNCTION "set_server_received_at"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW."received_at" := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "batches_set_server_received_at"
BEFORE INSERT ON "evidence_batches"
FOR EACH ROW EXECUTE FUNCTION "set_server_received_at"();

CREATE TRIGGER "events_set_server_received_at"
BEFORE INSERT ON "evidence_events"
FOR EACH ROW EXECUTE FUNCTION "set_server_received_at"();

CREATE TRIGGER "artifacts_set_server_received_at"
BEFORE INSERT ON "artifact_declarations"
FOR EACH ROW EXECUTE FUNCTION "set_server_received_at"();

CREATE FUNCTION "reject_raw_evidence_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format('%I is append-only; %s is not allowed', TG_TABLE_NAME, TG_OP);
END;
$$;

CREATE TRIGGER "evidence_batches_append_only"
BEFORE UPDATE OR DELETE ON "evidence_batches"
FOR EACH ROW EXECUTE FUNCTION "reject_raw_evidence_mutation"();

CREATE TRIGGER "evidence_events_append_only"
BEFORE UPDATE OR DELETE ON "evidence_events"
FOR EACH ROW EXECUTE FUNCTION "reject_raw_evidence_mutation"();

CREATE TRIGGER "evidence_batch_events_append_only"
BEFORE UPDATE OR DELETE ON "evidence_batch_events"
FOR EACH ROW EXECUTE FUNCTION "reject_raw_evidence_mutation"();

CREATE TRIGGER "artifact_declarations_append_only"
BEFORE UPDATE OR DELETE ON "artifact_declarations"
FOR EACH ROW EXECUTE FUNCTION "reject_raw_evidence_mutation"();

CREATE TRIGGER "evidence_event_artifacts_append_only"
BEFORE UPDATE OR DELETE ON "evidence_event_artifacts"
FOR EACH ROW EXECUTE FUNCTION "reject_raw_evidence_mutation"();

-- TRUNCATE GUARDS START
CREATE TRIGGER "evidence_batches_reject_truncate"
BEFORE TRUNCATE ON "evidence_batches"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_raw_evidence_mutation"();

CREATE TRIGGER "evidence_events_reject_truncate"
BEFORE TRUNCATE ON "evidence_events"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_raw_evidence_mutation"();

CREATE TRIGGER "evidence_batch_events_reject_truncate"
BEFORE TRUNCATE ON "evidence_batch_events"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_raw_evidence_mutation"();

CREATE TRIGGER "artifact_declarations_reject_truncate"
BEFORE TRUNCATE ON "artifact_declarations"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_raw_evidence_mutation"();

CREATE TRIGGER "evidence_event_artifacts_reject_truncate"
BEFORE TRUNCATE ON "evidence_event_artifacts"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_raw_evidence_mutation"();
-- TRUNCATE GUARDS END
