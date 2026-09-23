---
name: bbx-implement
description: Implement an Approved AI Agent Black Box task or an explicitly user-approved review fix pass; use for scoped repository changes and validation, not for drafting, independent review, or unauthorized finalization.
---

# Implement an Approved AI Agent Black Box Task

Implement only an approved specification or an explicitly user-approved fix pass for that specification.

## Gate and establish the baseline

1. Confirm that the task status is `Approved`, or that the user explicitly authorized a review fix pass. For initial implementation, also confirm that `HEAD` contains the unchanged approved task and use that commit as the baseline; stop if the approval or task change is uncommitted. Stop if neither implementation gate holds.
2. Read `AGENTS.md`, the approved task, and only the architecture documents referenced by that task before editing.
3. Establish the declared branch or commit baseline and inspect the complete worktree. Preserve unrelated user changes.
4. Treat the repository sources identified by `AGENTS.md` and the approved task as authoritative. If this guidance conflicts with a higher-priority source, stop and report the conflict.

## Implement and validate

- Stay within the approved scope and acceptance criteria. Do not silently expand the task or change an accepted ADR.
- Add or update tests for changed behavior.
- Run checks affected by the files or behavior being changed while implementing. Before handoff, run the task-required final local suite once against the final implementation state.
- A result is passing evidence only for the exact state on which it completed successfully. If that state changes, rerun only the checks affected by the change; do not repeat successful checks on an unchanged relevant state.
- Broaden validation when a check fails, a warning is unexplained, the relevant diff changes, or the scope includes a high-risk boundary identified by repository policy.
- Do not make redundant network requests; reuse existing evidence instead of repeating a network request merely to obtain additional metadata or confirmation. Permit task-required network access only when the network action is within the approved task scope and the user has explicitly authorized it. Do not start unrelated services or tools, including Docker, unless the approved task requires them and the user explicitly authorizes the action.
- Do not commit, push, mark the task `Done`, inspect hosted CI, or begin finalization during the implementation phase.

## Report and hand off

Write a compact implementation report in English. Include:

- changed files;
- exact commands and results;
- acceptance-criteria status;
- deviations from the specification;
- residual risks and explicitly excluded follow-up work.

For successful commands, report the exact command and concise result without routine output. Expand output only for failures or material warnings.

Stop after implementation and validation so an independent reviewer can inspect the unchanged worktree.

## Separate finalization phase

Finalize only after an independent review verdict of `PASS` and explicit user authorization. In that separately authorized phase, the agent may make only the mechanical task-status change to `Done`, then must provide the compact manual finalization handoff from `docs/tasks/README.md` and stop. The handoff identifies the reviewed baseline, exact file pathspecs, proposed commit message, status, explicit staging, staged-diff, commit, and push commands, and hosted-CI checklist. Never recommend `git add .` or another broad staging command.

Commit, push, and hosted-CI inspection remain user-managed by default. Agent execution requires an approved task-specific exception plus explicit user authorization, and does not bypass review, clean-diff, secret, destructive-action, evidence, or status gates. Label user-reported push and CI outcomes as user-provided evidence; never claim independently observed CI metadata that the agent did not inspect. Do not treat instructions such as "finish" as bypassing any gate.
