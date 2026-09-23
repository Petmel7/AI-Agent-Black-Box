# BBX-003B: Token-Efficient Delivery Workflow

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** No ADR required; repository workflow only

## Goal

Reduce repeated context, validation, and reporting work in the Architect →
Implementation → Review → Finalization workflow without weakening risk-based
quality gates.

## Context

BBX-003A introduced repository workflow Skills. The first use of that workflow
showed avoidable cost from duplicated task text, repeated full validation,
oversized reports, and worktree handoffs for sequential work. This task makes
the efficient path explicit while preserving deeper verification for risky
changes.

## In Scope

- Add a short `Validation Economy` policy to `AGENTS.md`.
- Update `$bbx-architect` to:
  - produce minimally sufficient task specifications;
  - reference authoritative documents instead of copying them;
  - generate short English handoff prompts containing the task path, baseline,
    scope gates, validation, and stop condition;
  - prefer the saved project checkout for sequential tasks and reserve
    worktrees for parallel or intentionally isolated work.
- Update `$bbx-implement` to:
  - run affected checks during implementation;
  - run the task-required final local suite once on the final implementation
    state;
  - avoid repeating successful checks on an unchanged state;
  - return a compact English handoff report, expanding command output only for
    failures or material warnings.
- Update `$bbx-review` to:
  - always inspect the complete diff;
  - independently reproduce affected and high-risk behavior;
  - reserve duplicate full-suite execution for migrations, authentication,
    tenant isolation, evidence integrity, concurrency, dependency, build-system,
    or otherwise justified high-risk changes;
  - return a compact handoff summary while retaining actionable finding detail.
- Update `docs/tasks/README.md` with:
  - local-checkout versus worktree guidance;
  - compact implementation and review report templates;
  - the risk-based validation stages.

## Required Policy

- Validation is proportional to the changed surface and risk.
- Successful checks are evidence only for the exact state on which they ran.
- A changed state invalidates only the evidence affected by that change.
- Implementation runs targeted checks while editing and one required final local
  gate before review.
- Review does not repeat the full deterministic suite by default; it verifies
  the diff, affected behavior, implementation claims, and high-risk boundaries.
- Finalization does not rerun unchanged successful local checks after review;
  hosted CI remains the full authoritative post-push gate.
- Any failure, unexplained warning, changed diff, or high-risk scope may require
  broader validation.
- Token efficiency never bypasses independent review, explicit authorization,
  secret protection, destructive-action controls, or evidence requirements.

## Out of Scope

- Product code, contracts, database, dependencies, lockfile, CI workflow, ADRs,
  or product scope.
- Hardcoded model names, reasoning effort, usage limits, machine paths, thread
  IDs, branch names, or commit SHAs.
- New Skills, plugins, scripts, hooks, MCP servers, or automations.
- Weakening the existing commit, push, network, Docker, task-status, or review
  authorization gates.

## Acceptance Criteria

- Only `AGENTS.md`, the three BBX `SKILL.md` files, this task status, and
  `docs/tasks/README.md` change.
- The source-of-truth hierarchy remains unchanged and duplicated guidance is not
  introduced.
- Handoff prompts rely on the approved task file instead of restating its full
  contents.
- Sequential work defaults to the saved checkout; worktree use has an explicit
  parallelism or isolation reason.
- Validation rules distinguish ordinary, high-risk, review, and finalization
  stages without making successful checks reusable after relevant changes.
- Compact report templates retain findings, failures, deviations, and material
  risks while omitting routine successful command output.
- Existing independent-review and explicit-authorization gates remain intact.
- No application behavior or tooling dependency changes.

## Validation

Implementation:

```text
pnpm format:check
git diff --check
git status --short --untracked-files=all
```

Also run structural checks for valid Skill frontmatter, expected files, forbidden
machine-specific content, and preservation of all authorization gates. The
existing hosted CI performs the complete lint, typecheck, test, and build suite
after the reviewed commit is pushed.

Review independently inspects the complete diff, verifies semantic consistency
across `AGENTS.md`, Skills, and task documentation, and repeats the focused
checks above. No database, Docker, network access, or package installation is
required.

## Deliverables

- Updated `AGENTS.md`.
- Updated `bbx-architect`, `bbx-implement`, and `bbx-review` Skills.
- Updated `docs/tasks/README.md`.
- Compact implementation and review handoff reports.

## Risks

- Under-testing if a task is incorrectly classified as low risk.
- Stale evidence if the diff changes after validation.
- Overly short reports hiding failures or material uncertainty.

The required policy above explicitly prevents these shortcuts.

## Open Questions

None. Model and reasoning-effort selection remain per-task Codex settings, not
repository policy.

## Implementation Prompt

```text
$bbx-implement docs/tasks/BBX-003B-token-efficient-delivery-workflow.md
Baseline: the approved specification commit.
Use the saved project checkout. Change only the approved workflow documents.
Run the task validation and stop before commit.
```

## Review Prompt

```text
$bbx-review docs/tasks/BBX-003B-token-efficient-delivery-workflow.md
Review the current diff against its approved baseline. Verify policy consistency,
authorization gates, scope, and focused validation. Do not edit or finalize.
```
