CREATE TYPE "ArtifactUploadState" AS ENUM (
    'issued', 'verifying', 'verified', 'rejected', 'expired'
);

CREATE TABLE "artifact_upload_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "artifact_declaration_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "state" "ArtifactUploadState" NOT NULL DEFAULT 'issued',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "verification_lease_id" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "observed_byte_length" BIGINT,
    "observed_sha256" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    CONSTRAINT "artifact_upload_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_upload_attempts_object_key_key" UNIQUE ("object_key"),
    CONSTRAINT "artifact_upload_attempts_expiry_check" CHECK ("expires_at" > "issued_at"),
    CONSTRAINT "artifact_upload_attempts_observed_length_check" CHECK ("observed_byte_length" IS NULL OR "observed_byte_length" >= 0),
    CONSTRAINT "artifact_upload_attempts_observed_sha256_check" CHECK ("observed_sha256" IS NULL OR "observed_sha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "artifact_upload_attempts_observation_pair_check" CHECK (("observed_byte_length" IS NULL) = ("observed_sha256" IS NULL)),
    CONSTRAINT "artifact_upload_attempts_error_code_check" CHECK ("last_error_code" IS NULL OR "last_error_code" IN ('integrity_mismatch', 'object_missing', 'payload_too_large', 'storage_unavailable')),
    CONSTRAINT "artifact_upload_attempts_state_shape_check" CHECK (
        ("state" = 'issued' AND "verification_lease_id" IS NULL AND "lease_expires_at" IS NULL AND "observed_byte_length" IS NULL AND "observed_sha256" IS NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "expired_at" IS NULL)
        OR ("state" = 'verifying' AND "verification_lease_id" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "observed_byte_length" IS NULL AND "observed_sha256" IS NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "expired_at" IS NULL)
        OR ("state" = 'verified' AND "verification_lease_id" IS NULL AND "lease_expires_at" IS NULL AND "observed_byte_length" IS NOT NULL AND "observed_sha256" IS NOT NULL AND "verified_at" IS NOT NULL AND "rejected_at" IS NULL AND "expired_at" IS NULL AND "last_error_code" IS NULL)
        OR ("state" = 'rejected' AND "verification_lease_id" IS NULL AND "lease_expires_at" IS NULL AND "rejected_at" IS NOT NULL AND "verified_at" IS NULL AND "expired_at" IS NULL AND "last_error_code" IN ('integrity_mismatch', 'object_missing', 'payload_too_large'))
        OR ("state" = 'expired' AND "verification_lease_id" IS NULL AND "lease_expires_at" IS NULL AND "observed_byte_length" IS NULL AND "observed_sha256" IS NULL AND "expired_at" IS NOT NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL)
    ),
    CONSTRAINT "artifact_upload_attempts_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "artifact_upload_attempts_org_run_fkey"
        FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "artifact_upload_attempts_org_run_artifact_fkey"
        FOREIGN KEY ("organization_id", "run_id", "artifact_declaration_id")
        REFERENCES "artifact_declarations"("organization_id", "run_id", "id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "artifact_upload_attempts_artifact_state_idx"
    ON "artifact_upload_attempts"("organization_id", "artifact_declaration_id", "state");

CREATE UNIQUE INDEX "artifact_upload_attempts_one_active_key"
    ON "artifact_upload_attempts"("artifact_declaration_id")
    WHERE "state" IN ('issued', 'verifying');

CREATE UNIQUE INDEX "artifact_upload_attempts_one_verified_key"
    ON "artifact_upload_attempts"("artifact_declaration_id")
    WHERE "state" = 'verified';

CREATE FUNCTION "enforce_artifact_upload_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."state" <> 'issued' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'artifact upload attempts must begin in issued state';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "artifact_upload_attempts_initial_state"
BEFORE INSERT ON "artifact_upload_attempts"
FOR EACH ROW EXECUTE FUNCTION "enforce_artifact_upload_insert"();

CREATE FUNCTION "enforce_artifact_upload_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
       OR NEW."artifact_declaration_id" IS DISTINCT FROM OLD."artifact_declaration_id"
       OR NEW."object_key" IS DISTINCT FROM OLD."object_key"
       OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'artifact upload identity is immutable';
    END IF;

    IF NOT (
        (OLD."state" = 'issued' AND NEW."state" IN ('verifying', 'rejected', 'expired'))
        OR (OLD."state" = 'verifying' AND NEW."state" IN ('issued', 'verifying', 'verified', 'rejected', 'expired'))
        OR (OLD."state" = NEW."state" AND OLD."state" IN ('verified', 'rejected', 'expired') AND NEW IS NOT DISTINCT FROM OLD)
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'illegal artifact upload state transition';
    END IF;

    IF OLD."state" = 'verifying' AND NEW."state" = 'verifying'
       AND OLD."lease_expires_at" >= clock_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active verification lease cannot be replaced';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "artifact_upload_attempts_legal_transition"
BEFORE UPDATE ON "artifact_upload_attempts"
FOR EACH ROW EXECUTE FUNCTION "enforce_artifact_upload_transition"();

CREATE FUNCTION "reject_artifact_upload_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'artifact upload attempts cannot be deleted';
    RETURN NULL;
END;
$$;

CREATE TRIGGER "artifact_upload_attempts_reject_delete"
BEFORE DELETE OR TRUNCATE ON "artifact_upload_attempts"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_artifact_upload_delete"();
