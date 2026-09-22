# BBX-001A: Update GitHub Actions Runtimes

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Parent task:** [BBX-001](./BBX-001-bootstrap-monorepo.md)
- **Architecture:** [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md)

## Goal

Remove the deprecated Node.js 20 action-runtime warning and make the bootstrap CI runner version explicit without changing application code or dependencies.

## Context

The first GitHub Actions run for commit `7da5737` passed all validation on Linux. GitHub reported that `actions/checkout@v4`, `actions/setup-node@v4`, and `pnpm/action-setup@v4` target the deprecated Node.js 20 action runtime and are being forced to run on Node.js 24. GitHub also reported that `ubuntu-latest` will migrate to Ubuntu 26.

This is a maintenance follow-up to BBX-001 and must be completed before BBX-002 begins.

## In Scope

- Update `.github/workflows/ci.yml`:
  - `actions/checkout@v4` to `actions/checkout@v7`.
  - `actions/setup-node@v4` to `actions/setup-node@v7`.
  - `pnpm/action-setup@v4` to `pnpm/action-setup@v6`.
  - `ubuntu-latest` to `ubuntu-24.04`.
- Preserve the existing Node.js version source, pnpm version source, frozen-lockfile installation, caching behavior, and validation commands unless a new action major requires a minimal compatible syntax adjustment.
- Run local validation, review the workflow diff, commit, push to `main`, and verify the resulting GitHub Actions run.

## Out of Scope

- Application or package source changes.
- Application dependency or lockfile changes.
- Migration to `pnpm/setup`.
- CI matrices, additional operating systems, deployment, release automation, or security scanning.
- Any BBX-002 product work.

## Architecture Constraints

- Keep CI aligned with the root validation commands established by BBX-001.
- Do not weaken frozen-lockfile enforcement or remove existing checks.
- Use the repository's declared Node.js and pnpm versions rather than duplicating divergent versions in the workflow.
- Keep the change reviewable as a dedicated maintenance commit.

## Acceptance Criteria

- CI uses `actions/checkout@v7`, `actions/setup-node@v7`, and `pnpm/action-setup@v6`.
- CI uses the explicit `ubuntu-24.04` runner label.
- Frozen-lockfile installation and all existing validation steps remain present.
- No application manifests, application source, package manifests, or `pnpm-lock.yaml` are changed.
- Local format, lint, typecheck, test, and build commands pass.
- The change receives an independent read-only review before commit and push.
- The pushed commit produces a successful GitHub Actions run for the exact commit SHA.
- The successful run no longer reports the Node.js 20 action-runtime warning or the `ubuntu-latest` migration warning.

## Validation Commands

```text
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short
```

After push, verify the workflow run conclusion, head SHA, job steps, and annotations in GitHub Actions.

## Deliverables

- Updated `.github/workflows/ci.yml`.
- This approved task specification.
- Implementation report with the exact local validation results.
- Review verdict.
- Local commit hash, push result, and GitHub Actions run result.

## Referenced Documents

- [`AGENTS.md`](../../AGENTS.md)
- [BBX-001](./BBX-001-bootstrap-monorepo.md)
- [Architecture overview](../architecture/overview.md)
- [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md)
- [Review guidelines](../review-guidelines.md)

## Risks

- New action majors can change defaults. Review the resulting workflow semantics rather than assuming the version-only diff is equivalent.
- A green local validation cannot prove hosted-runner compatibility; the exact pushed commit must complete successfully on GitHub Actions.
- Major action tags are convenient but mutable. Pinning actions to immutable commit SHAs may be introduced later as a separate supply-chain hardening task.

## Open Questions

None.

## Implementation Prompt

```text
Implement BBX-001A exactly as specified in docs/tasks/BBX-001A-update-github-actions-runtimes.md.

Read AGENTS.md and the referenced documents before editing. Change only the approved task document and .github/workflows/ci.yml. Do not change application code, package manifests, or the lockfile. Preserve the existing CI semantics and run every specified local validation command.

Do not commit or push until Review Chat returns an acceptable verdict. Report changed files, exact command outcomes, deviations, and residual risks.
```

## Review Prompt

```text
Review BBX-001A against AGENTS.md, its approved task specification, the complete diff, and the previous passing CI workflow.

Do not modify files. Verify the action and runner versions, preserved Node/pnpm version sources, frozen-lockfile behavior, caching, validation commands, scope discipline, and absence of unrelated changes. Report actionable findings first and end with PASS, PASS WITH FINDINGS, or REQUEST CHANGES.
```
