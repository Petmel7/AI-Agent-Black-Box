# BBX-003C: User-Managed Git Finalization

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** No ADR required; this changes repository workflow only and does not alter a product, trust, process-runtime, or data boundary.

## Goal

Make user-executed Git commit, push, and hosted-CI inspection the default delivery path, reducing agent usage and repeated network authorization without weakening review or evidence gates.

## Context

Use the workflow and validation rules in `AGENTS.md` and `docs/tasks/README.md`. BBX-003B established token-efficient validation; this task narrows finalization ownership and prevents uncommitted approved specifications from being used as implementation baselines.

## In Scope

- Update `AGENTS.md`, the three BBX Skills, and `docs/tasks/README.md`.
- Require an approved task specification to exist in a Git commit before implementation starts.
- Default commit, push, and hosted-CI inspection to the user.
- After approval or Review `PASS`, have the agent provide a compact manual handoff containing:
  - the expected baseline or reviewed commit;
  - exact file pathspecs and a proposed commit message;
  - status, staging, staged-diff, commit, and push commands;
  - a short hosted-CI checklist.
- Require `git add -- <explicit paths>`; never recommend `git add .`.
- Treat user-reported CI results as user-provided evidence and label them accordingly.
- Permit agent-executed Git/network finalization only as a task-specific exception with explicit user authorization.

## Out of Scope

- Product code, dependencies, lockfile, CI workflow, ADRs, or product scope.
- Scripts, hooks, plugins, MCP servers, automations, or GitHub integrations.
- Automatic parsing of screenshots or GitHub Actions results.
- Weakening independent review, task approval, clean-diff, secret, destructive-action, or evidence requirements.

## Required Behavior

1. Architecture stops before implementation until `HEAD` contains the unchanged `Approved` task; the user receives exact baseline commit commands.
2. Implementation and review do not commit or push.
3. After Review `PASS` and explicit finalization authorization, the agent may prepare the mechanical `Done` status change, then provides manual commands instead of executing Git/network actions.
4. The user verifies the staged file list before commit and reports push and CI outcomes.
5. The agent must not claim independently verified CI metadata it did not observe.

## Acceptance Criteria

- Only `AGENTS.md`, the three BBX `SKILL.md` files, this task status, and `docs/tasks/README.md` change.
- The approved-specification baseline gate is explicit and prevents the BBX-003B baseline failure mode.
- Manual handoffs use explicit pathspecs, never broad staging commands.
- Proposed commands preserve unrelated work and include staged-diff verification before commit.
- User-provided and agent-observed CI evidence remain distinguishable.
- Existing approval, independent-review, network, Docker, commit/push exception, and task-status gates remain intact.
- No runtime behavior or tooling dependency changes.

## Validation

```text
pnpm format:check
git diff --check
git status --short --untracked-files=all
```

Also inspect the complete diff and structurally verify Skill frontmatter, exact file scope, explicit pathspec examples, evidence labeling, and preservation of authorization gates. No package installation, database, Docker, network access, or full suite is required.

## Deliverables

- Updated repository workflow policy and BBX Skills.
- Updated task-workflow documentation with compact baseline and finalization command templates.

## Risks

- User command errors or accidental staging; mitigated by explicit paths and staged-diff inspection.
- Delayed or incomplete CI reporting; mitigated by evidence-source labeling and a fixed checklist.

## Open Questions

None.

## Implementation Prompt

```text
$bbx-implement docs/tasks/BBX-003C-user-managed-git-finalization.md
Use the committed Approved task as baseline in the saved checkout. Change only the approved workflow documents, run focused validation, and stop before commit.
```

## Review Prompt

```text
$bbx-review docs/tasks/BBX-003C-user-managed-git-finalization.md
Review the current diff against its committed baseline. Verify manual Git safety, evidence labeling, preserved authorization gates, and focused validation. Do not edit or finalize.
```
