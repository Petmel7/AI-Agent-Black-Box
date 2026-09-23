---
name: bbx-implement
description: Implement an Approved AI Agent Black Box task or an explicitly user-approved review fix pass; use for scoped repository changes and validation, not for drafting, independent review, or unauthorized finalization.
---

# Implement an Approved AI Agent Black Box Task

Implement only an approved specification or an explicitly user-approved fix pass for that specification.

## Gate and establish the baseline

1. Confirm that the task status is `Approved`, or that the user explicitly authorized a review fix pass. Stop if neither condition holds.
2. Read `AGENTS.md`, the approved task, and only the architecture documents referenced by that task before editing.
3. Establish the declared branch or commit baseline and inspect the complete worktree. Preserve unrelated user changes.
4. Treat the repository sources identified by `AGENTS.md` and the approved task as authoritative. If this guidance conflicts with a higher-priority source, stop and report the conflict.

## Implement and validate

- Stay within the approved scope and acceptance criteria. Do not silently expand the task or change an accepted ADR.
- Add or update tests for changed behavior.
- Run every task-required validation command against the final relevant state. A result is passing evidence only when the command completed successfully on that state.
- Do not make redundant network requests; reuse existing evidence instead of repeating a network request merely to obtain additional metadata or confirmation. Permit task-required network access only when the network action is within the approved task scope and the user has explicitly authorized it. Do not start unrelated services or tools, including Docker, unless the approved task requires them and the user explicitly authorizes the action.
- Do not commit, push, mark the task `Done`, or begin finalization during the implementation phase.

## Report and hand off

Write the implementation report in English. Include:

- changed files;
- exact commands and results;
- acceptance-criteria status;
- deviations from the specification;
- residual risks and explicitly excluded follow-up work.

Stop after implementation and validation so an independent reviewer can inspect the unchanged worktree.

## Separate finalization phase

Finalize only after an independent review verdict of `PASS` and explicit user authorization. In that separately authorized phase, update the task status as requested, commit exactly the reviewed diff, push it, and verify hosted CI for that exact commit. Do not treat instructions such as "finish" as bypassing either gate.
