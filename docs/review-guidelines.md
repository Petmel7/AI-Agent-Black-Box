# Review Guidelines

## Purpose

Review determines whether an implementation satisfies its approved task specification without introducing correctness, evidence-integrity, security, or maintainability regressions.

Review is independent from implementation. Unless the user explicitly requests fixes, the reviewer reports findings and does not modify files.

## Required Inputs

A review should identify:

- The approved task specification.
- The base branch or base commit.
- The exact diff or commit under review.
- Referenced ADRs and contracts.
- Validation commands and their recorded results.

If an input is unavailable, report the limitation rather than inferring it.

## Review Order

1. Read the task goal, non-goals, constraints, and acceptance criteria.
2. Read only the ADRs and contracts referenced by the task.
3. Inspect the complete diff against the declared base.
4. Trace changed behavior through callers, persistence, and error paths.
5. Inspect tests for both intended behavior and important negative cases.
6. Check validation results independently when practical.
7. Report actionable findings in priority order.
8. State residual risks and validation gaps even when there are no findings.

## Priority Levels

- **P0 — Critical:** Likely data loss, credential exposure, cross-tenant access, remote compromise, or a release-blocking failure with broad impact.
- **P1 — High:** Incorrect core behavior, corrupted or unverifiable evidence, broken idempotency, a serious regression, or a security boundary failure.
- **P2 — Medium:** A meaningful edge-case failure, incomplete error handling, contract drift, or missing tests that could hide an important defect.
- **P3 — Low:** A concrete maintainability or diagnostic weakness with limited immediate impact. Avoid subjective style feedback.

## Finding Format

Each finding must include:

- A concise title.
- Priority.
- File and precise line or smallest useful range.
- Concrete trigger or failure scenario.
- User or system impact.
- Why existing validation does not prevent it.
- The smallest safe correction or direction.

Do not report hypothetical issues without a plausible execution path. Do not report formatting issues already enforced by tooling.

## Project-Specific Review Checklist

### Evidence integrity

- Can raw evidence be changed, overwritten, or misattributed?
- Are content hashes calculated and preserved at the correct boundary?
- Are pre-existing Git changes distinguishable from agent changes?
- Is uncertainty represented explicitly?
- Does any summary claim exceed its evidence?

### Ingestion and retries

- Are batch and event identifiers stable?
- Is repeated delivery safe?
- Can partial persistence create an inconsistent run?
- Can a successful request lose the queued analysis job?
- Are request size, malformed payload, and unsupported-version failures explicit?

### Security and privacy

- Can secrets, authorization headers, prompts, or raw output reach logs?
- Are artifact downloads authorized?
- Is tenant ownership checked server-side?
- Does the safe metadata-only default remain intact?
- Are external inputs validated before use?

### Database and contracts

- Does the migration preserve existing data and rollback expectations?
- Do database constraints enforce durable invariants?
- Are schema changes reflected in runtime contracts?
- Is provider-specific data isolated from the canonical model?

### Testing

- Do tests exercise negative and retry paths?
- Are tests proving behavior rather than implementation details?
- Do tests cover the changed contract at its boundary?
- Were tests executed against the final relevant state?
- Are time, ordering, concurrency, and duplicate-delivery cases covered where relevant?

## Review Output

Use this structure:

```text
Findings
1. [P1] Finding title — path/to/file.ts:line
   Trigger, impact, evidence, and correction.

Open questions
- Only questions that block a confident review conclusion.

Residual risks
- Risks not proven to be defects in the current diff.

Validation gaps
- Checks that could not be run or evidence that was unavailable.
```

If there are no actionable findings, state: `No actionable findings.` Then list residual risks and validation gaps.
