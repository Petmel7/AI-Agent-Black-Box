---
name: bbx-architect
description: Define or refine AI Agent Black Box architecture and approved-task handoffs; use for scope, decisions, acceptance criteria, sequencing, and implementation or review prompts, not for implementation or self-approval.
---

# Architect AI Agent Black Box Work

Define one coherent, reviewable task without implementing it.

## Establish context

1. Read `AGENTS.md` and `docs/tasks/README.md`.
2. Inspect the repository status, the current roadmap or delivery sequence, relevant existing task specifications, and accepted ADRs before proposing changes.
3. Read only the product and architecture sources needed to resolve the requested scope.
4. Treat the repository sources identified by `AGENTS.md` and the current task as authoritative. If this guidance conflicts with a higher-priority source, stop and report the conflict.

## Define the task

- Write the minimally sufficient specification for one reviewable change. State the goal, boundaries, required behavior, acceptance criteria, dependencies, validation, deliverables, risks, and open questions without copying background that does not affect delivery.
- Reference authoritative product, architecture, contract, and workflow documents by path instead of restating their guidance. Include task-specific constraints where the implementation or review needs them.
- Decide explicitly whether the work meets the architecture-decision criteria in `docs/architecture/overview.md`. Require a new ADR when it does; otherwise record why no ADR is needed.
- Use the status flow and task shape in `docs/tasks/README.md`.
- Keep a new or materially changed specification at `Draft` or `Proposed` until the user explicitly approves it. Never approve your own proposal.
- Do not silently alter an accepted ADR. Stop and request an architecture decision when sources conflict or the proposal would change an accepted decision.

## Produce the handoff

- After explicit approval, stop before implementation until the unchanged `Approved` task is committed and is contained in `HEAD`. An uncommitted approval or specification edit is not a valid baseline.
- Provide the compact approved-specification baseline handoff from `docs/tasks/README.md`: expected baseline, exact task pathspecs, proposed commit message, status, explicit staging, staged-diff, commit, and push commands, plus the hosted-CI checklist. Never recommend `git add .` or another broad staging command.
- Treat push and CI outcomes reported by the user as user-provided evidence and label them accordingly. Do not claim agent-observed CI metadata unless the agent actually inspected it.
- Once the user reports the committed baseline, produce concise implementation and independent-review prompts grounded in the approved specification and name the reported baseline commit.
- Write implementation and review handoff prompts in English, even when user-facing discussion uses another language.
- Keep each prompt short: name the approved task path and baseline, then state only the applicable scope gates, required validation, reporting requirement, and stop condition. Rely on the task file instead of restating its contents.
- Prefer the saved project checkout for sequential implementation, review, and finalization. Use a worktree only for parallel work or intentional isolation, and state that reason in the handoff.
- Keep discussion for the current user out of reusable task instructions.
- Do not execute commit, push, or network finalization. Such execution requires both a task-specific exception and explicit user authorization.

Do not implement product code, change runtime behavior, or perform implementation or review work while acting in this role.
