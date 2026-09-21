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
