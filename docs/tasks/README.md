# Task Specifications

Task specifications are the handoff contract between architecture, implementation, and review.

## Status Flow

```text
Draft → Proposed → Approved → In Progress → In Review → Done
                   ↘ Blocked
```

Only tasks with `Status: Approved` may enter implementation. Changing scope after approval requires updating the task and returning it to `Proposed` unless the change is a clarification that does not affect acceptance criteria or architecture.

## Required Sections

Each implementation task should contain:

- Goal.
- Context.
- In scope.
- Out of scope.
- Architecture constraints.
- Required changes.
- Acceptance criteria.
- Required tests.
- Validation commands.
- Deliverables.
- Referenced decisions and documents.
- Risks.
- Open questions.

## Task Size

A task should produce one reviewable change with one coherent purpose. Split it when:

- It contains independently valuable vertical slices.
- It mixes architecture work with unrelated product behavior.
- Different parts require different reviewers or risk profiles.
- The expected diff is too large to review confidently.

## Completion Report

Implementation should finish with:

- Acceptance criteria status.
- Changed files.
- Commands executed and results.
- Deviations from the specification.
- Residual risks.
- Follow-up work explicitly excluded from the current task.

## Repository Workflow Skills

Three repository-scoped Codex Skills support the recurring task workflow:

- `$bbx-architect` defines or refines scope, architecture decisions, acceptance criteria, dependency order, and English implementation and review handoffs. It does not implement or approve its own proposal.
- `$bbx-implement` implements an `Approved` task or an explicitly approved review fix pass, validates the final relevant state, and reports evidence in English. It does not independently review or finalize without the required gates.
- `$bbx-review` independently reviews a declared diff or commit without editing and ends with `PASS` or `NEEDS FIXES`.

Invoke a Skill explicitly in a prompt, for example:

```text
$bbx-architect define the scope and acceptance criteria for the next task.
$bbx-implement implement the Approved task in docs/tasks/<task>.md.
$bbx-review independently review the current diff against docs/tasks/<task>.md.
```

These Skills describe workflow roles; they are not new sources of product truth. `AGENTS.md`, the current approved task, and accepted ADRs remain authoritative under the repository's documented source-of-truth hierarchy.
