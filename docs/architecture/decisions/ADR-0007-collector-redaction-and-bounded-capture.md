# ADR-0007: Collector Redaction and Bounded Capture Trust Boundary

- **Status:** Accepted
- **Date:** 2026-09-24
- **Decision owners:** Project architecture

## Context

The collector observes content close to a developer's repository and process:
commands, paths, prompts, tool inputs and outputs, logs, diffs, environment-derived
values, and provider payloads. This is the last reliable point at which secrets
and unwanted raw content can be removed before evidence is hashed, spooled,
uploaded, or logged.

Redaction cannot prove that arbitrary text is safe. Overly broad capture creates
privacy risk, while silently dropping content creates false confidence. The
collector therefore needs a default capture policy, deterministic redaction
semantics, bounded memory and disk behavior, and explicit failure states.

## Decision

Make metadata-only collection the default and treat local redaction as a
fail-closed transformation before every durable or external boundary.

### Capture profiles

The default profile records canonical metadata and explicitly marks sensitive
content as `omitted`. Raw task descriptions, prompts, command text, working
directories, stdout, stderr, tool inputs and outputs, provider-native payloads,
and full file content require explicit content-capture opt-in.

An opt-in applies only to the requested capture classes. It is not consent to
collect hidden chain-of-thought, credentials, raw authorization headers, or
unbounded binary data. Provider content that is undocumented or unavailable is
recorded as unavailable, not inferred.

### Redaction pipeline

For opted-in textual content, the collector performs this order exactly:

1. accept bytes only up to the configured input bound;
2. decode strict UTF-8 or mark content unavailable;
3. normalize only transport-safe line endings where the capture type requires
   it; otherwise preserve text semantics;
4. replace all overlapping secret matches deterministically;
5. derive the bounded excerpt from redacted text;
6. optionally encode/compress the full redacted artifact;
7. calculate artifact byte length and SHA-256 over the exact final bytes;
8. persist only the canonical capture and final artifact bytes.

Unredacted content must not be written to SQLite, temporary files, artifact
files, logs, errors, traces, snapshots, or test fixtures. Temporary artifact
files are created only after redaction.

`redaction.applied: true` means the content passed successfully through the
active ruleset; it does not claim that a match was found or that all possible
secrets were recognized. The initial public ruleset identifier is
`collector-redaction-v1`. Match counts and rule identifiers are local safe
diagnostics only and are not copied into canonical content.

### Initial ruleset

The v0.1 ruleset combines:

- fixed project-owned detectors for authorization header values, URL userinfo,
  private-key blocks, and high-confidence common credential formats;
- the Black Box API token and other collector credentials held in memory;
- values of environment variables whose names match a conservative secret-name
  allowlist pattern or are explicitly named by the user;
- exact literal values read from an explicitly selected local redaction file.

Secret values below a conservative minimum length are not registered as global
literal rules because they would destroy ordinary text. Configuration reports
this safely without printing the name/value pair where doing so could disclose
intent.

All replacements use a constant marker independent of the secret value and its
length. Overlapping matches are merged before replacement. Rule evaluation is
deterministic and bounded by input size and rule count.

User-provided arbitrary regular expressions are out of scope for v0.1. JavaScript
regular expressions can cause catastrophic backtracking, and accepting them at
this trust boundary would let configuration block the wrapped process. Later
support requires a separately evaluated linear-time engine and rule limits.

### Paths and local identity

When opted-in text contains known repository-root or user-home prefixes, the
collector replaces them with stable placeholders before other persistence.
Absolute paths are otherwise omitted by default. Path replacement is privacy
reduction, not a security guarantee; path-like strings still pass through the
complete redaction ruleset.

### Failure behavior

Invalid redaction configuration fails before launching the wrapped process.
After launch, a redactor, decoder, or capture failure never falls back to raw
content. The canonical field becomes `unavailable` with `collection-failed`, a
safe local diagnostic is recorded, and the child process continues.

If the capture bound or spool quota is reached, the collector keeps only a
redacted bounded excerpt where possible and marks it truncated. If even safe
bounded content cannot be persisted, it records unavailable state when durable
capacity permits and emits a visible safe warning. It never claims successful
full capture.

### Local threat model

The collector protects against accidental upload, logging, or repository commit
of recognizable secrets and against backend unavailability. It assumes the
developer's operating-system account and collector process are trusted.

The v0.1 spool is not encrypted at rest and does not defend against a compromised
host, privileged local malware, memory inspection, screen capture, malicious
agent output designed to evade detectors, or unknown secret formats. These
limitations are documented prominently. Redaction is defense in depth, not a
substitute for credential rotation or repository secret scanning.

## Consequences

### Positive

- Sensitive raw content is disabled unless explicitly requested.
- Hashes, excerpts, files, and uploads all describe the same redacted bytes.
- Redaction errors cannot silently fall back to unsafe capture.
- The first ruleset is deterministic and avoids user-controlled regex denial of
  service.
- Tests can scan the complete spool, WAL, temporary directory, logs, and request
  bodies for secret sentinels.

### Negative

- Metadata-only evidence is less detailed until users opt in.
- Exact and high-confidence detectors may miss unknown or obfuscated secrets.
- Some legitimate text may be replaced by built-in detectors.
- No arbitrary regex support limits customization in v0.1.
- Unencrypted local evidence remains readable to an attacker with local account
  or higher privileges.

## Alternatives Considered

### Capture everything and redact on the server

Rejected because raw secrets would already have crossed the machine and become
durable before the trusted redaction point.

### Treat a successful redaction pass as proof that content is secret-free

Rejected because no finite pattern set can establish that claim.

### Accept JavaScript regular expressions from configuration

Rejected for v0.1 because catastrophic backtracking can block capture and the
wrapped process lifecycle.

### Encrypt the spool with an application-managed key

Deferred because storing the key beside the database provides little protection.
A future encrypted spool requires operating-system keychain integration and its
own recovery decision.

## Follow-up Work

- BBX-006 implements the ruleset, bounded capture pipeline, diagnostics, and
  secret-sentinel tests.
- BBX-007 applies the same boundary to Git status, paths, and diff artifacts.
- BBX-008 applies it to documented Codex telemetry and provider payloads.
- A future security task may add OS-keychain-backed spool encryption and a
  linear-time custom pattern engine.

## References

- [v0.1 product scope](../../product/v0.1-scope.md)
- [Architecture overview](../overview.md)
- [Canonical Evidence Model](../evidence-model.md)
- [ADR-0002](ADR-0002-canonical-evidence-envelope.md)
- [ADR-0006](ADR-0006-local-spool-and-delivery-state.md)
