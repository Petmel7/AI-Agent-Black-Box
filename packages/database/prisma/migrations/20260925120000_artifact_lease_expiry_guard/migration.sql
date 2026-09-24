CREATE OR REPLACE FUNCTION "enforce_artifact_upload_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
       OR NEW."artifact_declaration_id" IS DISTINCT FROM OLD."artifact_declaration_id"
       OR NEW."object_key" IS DISTINCT FROM OLD."object_key"
       OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
       OR (NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
           AND NOT (OLD."state" = 'issued' AND NEW."state" = 'issued')) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'artifact upload identity is immutable';
    END IF;

    IF NOT (
        (OLD."state" = 'issued' AND NEW."state" IN ('issued', 'verifying', 'rejected', 'expired'))
        OR (OLD."state" = 'verifying' AND NEW."state" IN ('issued', 'verifying', 'verified', 'rejected', 'expired'))
        OR (OLD."state" = NEW."state" AND OLD."state" IN ('verified', 'rejected', 'expired') AND NEW IS NOT DISTINCT FROM OLD)
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'illegal artifact upload state transition';
    END IF;

    IF OLD."state" = 'issued' AND NEW."state" = 'issued'
       AND (NEW."expires_at" <= clock_timestamp() OR NEW."last_error_code" IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'issued capability refresh must remain active';
    END IF;

    IF OLD."state" = 'verifying' AND NEW."state" = 'verifying'
       AND OLD."lease_expires_at" >= clock_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active verification lease cannot be replaced';
    END IF;

    IF OLD."state" = 'verifying' AND NEW."state" IN ('verified', 'rejected')
       AND OLD."lease_expires_at" <= clock_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'expired verification lease cannot write terminal state';
    END IF;
    RETURN NEW;
END;
$$;
