# BBX-003A: Repository Workflow Skills

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** No new ADR required; this task changes repository-local development workflow only

## Goal

Add three small, repository-scoped Codex Skills that make the established
architecture, implementation, and independent-review workflow repeatable without
duplicating the project's durable rules from `AGENTS.md`.

## Context

BBX-001 through BBX-003 established a reliable delivery loop:

1. Architect Chat defines scope, decisions, acceptance criteria, and handoff
   prompts.
2. Implementation Chat executes only an approved task and reports evidence.
3. Review Chat independently inspects and reproduces the result without editing.
4. A task is finalized, committed, pushed, and verified in hosted CI only after
   an independent `PASS` and explicit user authorization.

The workflow is now stable enough to encode as reusable repository guidance.
`AGENTS.md` remains the source of durable project constraints. The new Skills
must describe how to perform recurring jobs, not restate the complete technology
baseline or architecture.

## In Scope

- Add exactly three repository-scoped, instruction-only Skills:
  - `.agents/skills/bbx-architect/SKILL.md`;
  - `.agents/skills/bbx-implement/SKILL.md`;
  - `.agents/skills/bbx-review/SKILL.md`.
- Give every Skill valid YAML frontmatter with a unique `name` and a concise,
  trigger-oriented `description` that states both its intended use and its main
  boundary.
- Make the Skills usable through explicit invocation:
  - `$bbx-architect`;
  - `$bbx-implement`;
  - `$bbx-review`.
- Allow implicit invocation only where the description can distinguish the job
  without overlapping the other two Skills.
- Keep instructions imperative, scoped, and explicit about required inputs,
  outputs, gates, and prohibited actions.
- Require prompts handed to Implementation Chat and Review Chat to be written in
  English. User-facing discussion may remain in the user's language.
- Add a short repository workflow section to `docs/tasks/README.md` documenting
  the three Skills, explicit invocation examples, and the fact that
  `AGENTS.md`, approved tasks, and accepted ADRs remain authoritative.
- Validate the Skill metadata and exercise a small trigger matrix covering
  correct selection and important non-selection cases.

## Required Skill Behavior

### `bbx-architect`

- Use for defining or refining scope, architecture decisions, task
  specifications, acceptance criteria, dependency order, and handoff prompts.
- Inspect the current roadmap, relevant existing task specifications, accepted
  ADRs, and repository status before proposing changes.
- Decide explicitly whether a new ADR is required under the repository's
  architecture-decision rules.
- Produce one coherent task specification using the status flow in
  `docs/tasks/README.md`.
- Keep a new or materially changed task at `Draft` or `Proposed` until the user
  explicitly approves it.
- Produce concise English implementation and review prompts based on the
  approved specification.
- Never implement product code, approve its own proposal, or silently change an
  accepted ADR.

### `bbx-implement`

- Use only to implement a task whose specification is `Approved`, or to apply a
  user-approved fix pass to that task.
- Read `AGENTS.md`, the approved task, and only the architecture documents the
  task references before editing.
- Establish the declared baseline and inspect the existing worktree before
  making changes.
- Preserve unrelated user work and remain inside the approved scope.
- Add or update tests for changed behavior and run the task's required
  validation against the final relevant state.
- Report changed files, exact commands and results, acceptance-criteria status,
  deviations, and residual risks in English.
- Treat claimed results as valid only when the corresponding command actually
  completed successfully on the reported state.
- Do not commit, push, change the task to `Done`, start unrelated tools such as
  Docker, or make redundant network requests without task scope and explicit
  user authorization.
- After an independent `PASS` and explicit user authorization, allow a separate
  finalization phase that updates task status, commits the reviewed diff, pushes
  it, and verifies hosted CI for the exact commit.

### `bbx-review`

- Use for independent review of a declared diff or commit against an approved
  task, referenced ADRs, contracts, and `docs/review-guidelines.md`.
- Remain read-only unless the user explicitly requests a separate fix task.
- Independently inspect the complete diff and reproduce important validation;
  do not treat the implementation report as proof.
- Prioritize correctness, evidence integrity, tenant isolation, secret safety,
  idempotency, migration risk, contract compatibility, and missing behavioral
  tests.
- Every finding must include priority, precise location, concrete trigger,
  impact, missing protection, and the smallest safe correction.
- Distinguish actionable findings from residual risks and validation gaps.
- For repeat review, include a closure audit of every earlier finding.
- End with exactly one verdict: `PASS` or `NEEDS FIXES`. State
  `No actionable findings.` explicitly when appropriate.
- Never commit, push, change task status, or modify reviewed files.

## Source-of-Truth and Precedence Rules

The Skills must reference, not reproduce, the repository's source-of-truth
hierarchy:

1. The current approved task specification for task-specific behavior.
2. Accepted ADRs.
3. The architecture overview.
4. Product scope.
5. `AGENTS.md` for repository-wide operating and quality rules.

If a Skill instruction would conflict with a higher-priority source, the Skill
must stop and report the conflict rather than resolve it silently.

## Trigger Matrix

Implementation and review must exercise at least these cases and record the
observed Skill selection or non-selection:

| Prompt intent                                             | Expected Skill           |
| --------------------------------------------------------- | ------------------------ |
| Define BBX-004 scope and decide whether an ADR is needed  | `bbx-architect`          |
| Implement an existing `Approved` BBX task                 | `bbx-implement`          |
| Apply an explicitly approved review fix pass              | `bbx-implement`          |
| Independently review an implementation without editing    | `bbx-review`             |
| Explain the project architecture without proposing a task | No forced workflow Skill |
| Answer an unrelated TypeScript question                   | No BBX Skill             |

If implicit selection cannot be observed deterministically in the available
Codex environment, review must at minimum inspect the descriptions against this
matrix and explicitly report the validation limitation. Explicit invocation of
all three Skills must still be documented and structurally valid.

## Out of Scope

- Product code, application behavior, database schema, migrations, contracts,
  CI workflows, or runtime dependencies.
- Changes to `AGENTS.md`, accepted ADRs, product scope, or the v0.1 delivery
  sequence.
- Personal or machine-wide Skills under a user home directory.
- Plugins, marketplace packaging, MCP servers, connectors, hooks, automations,
  subagent definitions, or custom tools.
- Scripts, executable helpers, templates, assets, icons, or `agents/openai.yaml`.
- Automatic creation, renaming, archiving, or approval of Codex tasks.
- Broad prompt libraries or provider-specific workflows for Claude Code,
  Copilot, Cursor, or OpenCode.

## Architecture and Safety Constraints

- Skills are workflow guidance, not new sources of product truth.
- Keep each Skill focused on one job and small enough to review as instructions.
- Do not duplicate large sections of `AGENTS.md`, task templates, ADRs, or review
  guidelines.
- Do not place credentials, environment values, machine-specific absolute paths,
  branch names, commit SHAs, task IDs, or chat/thread IDs in a Skill.
- Do not grant broader authority than the active task and explicit user
  approvals provide.
- A terminal instruction such as "finish" does not bypass review, commit, push,
  network, destructive-action, or task-status gates.
- Repository discovery must work from the repository root and nested workspace
  directories through the standard `.agents/skills` location.

## Acceptance Criteria

- Exactly the three requested Skill directories and `SKILL.md` files exist under
  the repository-root `.agents/skills` directory.
- Each `SKILL.md` has valid YAML frontmatter containing only a stable unique
  `name` and a clear `description` unless an additional field is demonstrably
  required.
- Folder names, Skill names, documentation, and invocation examples agree.
- The three descriptions have distinct positive triggers and clear boundaries,
  minimizing accidental overlap.
- Instructions implement all behavior and gates in this specification without
  copying the repository's full architecture or code standards.
- Implementation and review handoff output is required to be in English.
- `bbx-implement` cannot start a task that is not `Approved` and cannot
  commit/push/finalize without independent `PASS` plus explicit user approval.
- `bbx-review` is read-only, independently validates claims, uses the repository
  finding format, and emits a single final verdict.
- `bbx-architect` does not implement code or self-approve task specifications.
- `docs/tasks/README.md` documents the workflow and explicit invocation syntax.
- The trigger matrix is evaluated and any environment limitation is reported.
- Existing repository checks still pass and the final diff contains no product,
  dependency, lockfile, CI, or unrelated documentation changes.

## Required Validation

The implementation must run and report:

```text
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Review must additionally inspect all Skill frontmatter, compare descriptions
against the trigger matrix, check for duplicated or conflicting repository
rules, and verify that no out-of-scope files changed.

No database connection, Docker service, external network access, or new package
installation is required by this task.

## Deliverables

- `.agents/skills/bbx-architect/SKILL.md`
- `.agents/skills/bbx-implement/SKILL.md`
- `.agents/skills/bbx-review/SKILL.md`
- Updated `docs/tasks/README.md`
- Implementation report with trigger-matrix evidence and required validation
  results
- Independent review report with a final verdict

## Referenced Documents

- [`AGENTS.md`](../../AGENTS.md)
- [Task specification workflow](README.md)
- [Review guidelines](../review-guidelines.md)
- [Architecture overview](../architecture/overview.md)
- [v0.1 product scope](../product/v0.1-scope.md)

## Risks

- Broad descriptions could activate the wrong Skill and blur separation between
  architecture, implementation, and review.
- Repeating `AGENTS.md` inside Skills could cause instructions to drift as the
  repository evolves.
- An implementation Skill with implicit commit or push authority could bypass
  the established review gate.
- A review Skill that trusts implementation summaries could repeat the false
  positive validation pattern found during BBX-003.
- Too many workflow details could make the Skills harder to maintain than the
  manual process they replace.

## Open Questions

None. This task deliberately starts with instruction-only, repository-scoped
Skills. UI metadata, scripts, plugins, and cross-repository distribution require
separate justification.

## Implementation Prompt

```text
Implement BBX-003A exactly as approved in
docs/tasks/BBX-003A-repository-workflow-skills.md.

Read AGENTS.md, docs/tasks/README.md, docs/review-guidelines.md, and only the
additional documents referenced by the task before editing. Add exactly the
three repository-scoped instruction-only Skills under .agents/skills and update
the task workflow documentation. Keep AGENTS.md authoritative and reference it
instead of copying its full rules into each Skill.

Do not change product code, dependencies, lockfiles, CI, architecture decisions,
or runtime behavior. Do not add scripts, plugins, MCP dependencies, UI metadata,
or machine-specific values. Evaluate the required trigger matrix, run every
required validation command, and report exact results, changed files,
acceptance-criteria status, deviations, and residual risks in English.

Do not commit, push, or change the task status before independent review and
explicit user authorization.
```

## Review Prompt

```text
Independently review BBX-003A against AGENTS.md, its approved task
specification, docs/tasks/README.md, and docs/review-guidelines.md. Do not modify
files.

Inspect the complete diff and all three SKILL.md files. Verify valid frontmatter,
distinct trigger descriptions, source-of-truth precedence, role separation,
English handoff output, review independence, and explicit approval gates for
finalization, commit, push, and hosted verification. Check that the Skills do
not duplicate large repository rules or contain machine-specific values, task
IDs, secrets, scripts, plugin metadata, or broader authority than the active
task grants.

Evaluate the trigger matrix and independently run the required repository
validation where practical. Report actionable findings first with priority,
location, concrete trigger, impact, and smallest safe correction. Then report
acceptance-criteria status, validation performed, residual risks, validation
gaps, and one final verdict: PASS or NEEDS FIXES. If no actionable findings
exist, state "No actionable findings." explicitly.
```
