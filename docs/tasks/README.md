# Task Specifications

Task specifications are the handoff contract between architecture, implementation, and review.

## Status Flow

```text
Draft → Proposed → Approved → In Progress → In Review → Done
                   ↘ Blocked
```

Only tasks with `Status: Approved` may enter implementation. The unchanged approved task must also be tracked in `HEAD`, and that commit is the implementation baseline; an approval or task edit that exists only in the worktree is not sufficient. Changing scope after approval requires updating the task and returning it to `Proposed` unless the change is a clarification that does not affect acceptance criteria or architecture.

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

## Checkout Choice

Use the saved project checkout for sequential implementation, review, and finalization. Use a worktree only when work will proceed in parallel or requires intentional isolation, and record that reason in the handoff. The checkout choice does not change review, authorization, or evidence requirements.

## Risk-Based Validation

Use the `Validation Economy` policy in `AGENTS.md` throughout delivery:

1. **Implementation editing:** run checks affected by the current change.
2. **Implementation handoff:** run the task-required final local gate once on the final implementation state.
3. **Independent review:** inspect the complete diff and independently verify affected behavior, implementation claims, and high-risk boundaries. Repeat the full deterministic suite only for the high-risk cases defined in `AGENTS.md` or when another documented reason justifies it.
4. **Finalization:** do not rerun unchanged successful local checks after review; hosted CI is the full authoritative post-push gate. The user performs commit, push, and hosted-CI inspection by default.

Successful evidence applies only to the exact state tested. A later change invalidates only affected evidence. Failures, unexplained warnings, changed relevant diffs, or newly discovered risk require broader validation.

## Compact Handoff Reports

Implementation report:

```text
Changed files: <paths>
Validation: <exact command — concise result>
Acceptance criteria: <met or exceptions>
Deviations: <none or details>
Residual risks / excluded follow-up: <none or details>
Stop: ready for independent review; not committed or finalized
```

Review report:

```text
Findings: <No actionable findings. or full actionable findings>
Validation: <exact command — concise result>
Acceptance criteria and scope: <met or exceptions>
Residual risks / validation gaps: <none or details>
Verdict: <PASS or NEEDS FIXES>
```

Keep successful command output summarized. Preserve details for findings, failures, deviations, material warnings, and residual risks.

## Manual Git Handoffs

Git finalization is user-managed by default. Agents may execute commit, push, or network finalization only when an approved task defines that specific exception and the user explicitly authorizes it. These exceptions do not weaken approval, independent-review, clean-diff, secret, destructive-action, evidence, or task-status gates.

After task approval, architecture must stop before implementation and provide a baseline handoff using this shape:

```text
Expected baseline: the commit created from the unchanged Approved task
Exact pathspecs: docs/tasks/<task>.md
Proposed commit message: docs(tasks): approve <task>
Commands:
  git status --short --untracked-files=all
  git add -- docs/tasks/<task>.md
  git diff --cached --name-only
  git diff --cached --check
  git diff --cached
  git commit -m "docs(tasks): approve <task>"
  git push <remote> <branch>
  git rev-parse HEAD
Hosted CI: confirm the pushed commit SHA; confirm required checks completed; report pass/fail and links or check names when available
Stop: implementation may start only after the user reports the committed baseline
```

Replace every placeholder with repository facts before presenting the handoff. The user must verify that `git diff --cached --name-only` contains exactly the intended files before committing. Always use `git add -- <explicit paths>`; never recommend `git add .`, `git add -A`, or another broad staging command.

After Review `PASS` and explicit finalization authorization, an agent may prepare only the mechanical task status change to `Done`. It then stops and provides this finalization handoff:

```text
Expected reviewed baseline: <base commit and reviewed worktree/diff identity, or reviewed commit>
Exact pathspecs: <every reviewed path plus docs/tasks/<task>.md for the authorized Done change>
Proposed commit message: <task id and concise outcome>
Commands:
  git status --short --untracked-files=all
  git add -- <explicit path 1> <explicit path 2> docs/tasks/<task>.md
  git diff --cached --name-only
  git diff --cached --check
  git diff --cached
  git commit -m "<proposed message>"
  git push <remote> <branch>
Hosted CI: confirm the pushed commit SHA matches the local commit; confirm required checks completed; report pass/fail and links or check names when available
Stop: the user reports the push and hosted-CI outcome
```

User-reported push and CI outcomes are user-provided evidence and must be labeled that way. An agent must not claim CI details as independently verified unless it actually observed them under an authorized task-specific exception.

## Completion Report

The compact implementation report must retain:

- Acceptance criteria status.
- Changed files.
- Commands executed and results.
- Deviations from the specification.
- Residual risks.
- Follow-up work explicitly excluded from the current task.

## Repository Workflow Skills

Three repository-scoped Codex Skills support the recurring task workflow:

- `$bbx-architect` defines or refines scope, architecture decisions, acceptance criteria, dependency order, and English implementation and review handoffs. It does not implement or approve its own proposal.
- `$bbx-implement` implements a committed `Approved` task or an explicitly approved review fix pass, validates the final relevant state, and reports evidence in English. It does not independently review or finalize without the required gates.
- `$bbx-review` independently reviews a declared diff or commit without editing, ends with `PASS` or `NEEDS FIXES`, and after `PASS` supplies the gated manual finalization handoff.

Invoke a Skill explicitly in a prompt, for example:

```text
$bbx-architect define the scope and acceptance criteria for the next task.
$bbx-implement implement the Approved task in docs/tasks/<task>.md.
$bbx-review independently review the current diff against docs/tasks/<task>.md.
```

These Skills describe workflow roles; they are not new sources of product truth. `AGENTS.md`, the current approved task, and accepted ADRs remain authoritative under the repository's documented source-of-truth hierarchy.
